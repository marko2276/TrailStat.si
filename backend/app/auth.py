"""Authentication: validates Hanko session tokens (JWT) against Hanko's public keys.

TrailStat never sees passwords. Everything specific to the provider is in this module,
so another provider can be swapped in (see ADR 0003).
"""

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from typing import Annotated, Any

import httpx
import jwt
from fastapi import Depends, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_session
from app.errors import ApiError
from app.models import User

logger = logging.getLogger(__name__)

bearer_scheme = HTTPBearer(auto_error=False)

# Not derived from the e-mail address, whose local part would show to everyone in a group.
DEFAULT_DISPLAY_NAME = "Hiker"

# Our clock and Hanko's are never exactly equal. Without this, a token used right after signing in
# can look issued in the future and be refused, which sends the user back to the login page.
TOKEN_CLOCK_LEEWAY_SECONDS = 60


@dataclass(frozen=True)
class TokenIdentity:
    subject: str
    email: str | None
    raw_token: str
    email_verified: bool = False


@lru_cache
def get_jwk_client() -> jwt.PyJWKClient:
    settings = get_settings()
    if not settings.hanko_api_url:
        raise ApiError(status.HTTP_503_SERVICE_UNAVAILABLE, "auth_not_configured")
    url = f"{settings.hanko_api_url.rstrip('/')}/.well-known/jwks.json"
    # Only the key set is cached, for its lifespan. `cache_keys` would keep trusting a key after
    # Hanko removed it, for as long as the process runs.
    return jwt.PyJWKClient(url, cache_keys=False, lifespan=3600, timeout=10)


def _email_from_claims(claims: dict[str, Any]) -> str | None:
    email = claims.get("email")
    if isinstance(email, dict):
        email = email.get("address")
    return email if isinstance(email, str) and email else None


def _email_verified_from_claims(claims: dict[str, Any]) -> bool:
    email = claims.get("email")
    return isinstance(email, dict) and email.get("is_verified") is True


def decode_token(token: str) -> TokenIdentity:
    try:
        signing_key = get_jwk_client().get_signing_key_from_jwt(token).key
    except jwt.PyJWKClientConnectionError as exc:
        logger.exception("Could not fetch Hanko's public keys")
        raise ApiError(status.HTTP_503_SERVICE_UNAVAILABLE, "auth_unavailable") from exc
    except jwt.PyJWKClientError as exc:
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "invalid_token") from exc
    except jwt.InvalidTokenError as exc:
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "invalid_token") from exc

    audience = get_settings().hanko_audience
    try:
        claims = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            audience=audience or None,
            leeway=TOKEN_CLOCK_LEEWAY_SECONDS,
            options={"require": ["exp", "sub"], "verify_aud": bool(audience)},
        )
    except jwt.InvalidTokenError as exc:
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "invalid_token") from exc
    return TokenIdentity(
        claims["sub"],
        _email_from_claims(claims),
        token,
        email_verified=_email_verified_from_claims(claims),
    )


def fetch_email_from_hanko(identity: TokenIdentity) -> str:
    """Fallback for tokens without an e-mail claim."""
    url = f"{get_settings().hanko_api_url.rstrip('/')}/users/{identity.subject}"
    try:
        response = httpx.get(
            url, headers={"Authorization": f"Bearer {identity.raw_token}"}, timeout=10
        )
        response.raise_for_status()
        email = response.json().get("email")
    except (httpx.HTTPError, ValueError) as exc:
        logger.exception("Could not fetch the user's e-mail address from Hanko")
        raise ApiError(status.HTTP_503_SERVICE_UNAVAILABLE, "auth_unavailable") from exc
    if not isinstance(email, str) or not email:
        logger.error("Hanko returned no e-mail address for a user")
        raise ApiError(status.HTTP_503_SERVICE_UNAVAILABLE, "auth_unavailable")
    return email


def get_or_create_user(session: Session, identity: TokenIdentity) -> User:
    user = session.scalar(select(User).where(User.auth_subject == identity.subject))
    today = datetime.now(UTC).date()
    if user is not None:
        changed = False
        if identity.email and identity.email != user.email:
            user.email = identity.email
            changed = True
        if user.last_seen_on != today:
            user.last_seen_on = today
            changed = True
        if changed:
            session.commit()
        return user

    email = identity.email or fetch_email_from_hanko(identity)
    # ON CONFLICT: the app's first requests after sign-up arrive in parallel.
    session.execute(
        insert(User)
        .values(
            auth_subject=identity.subject,
            email=email,
            display_name=DEFAULT_DISPLAY_NAME,
            last_seen_on=today,
        )
        .on_conflict_do_nothing(index_elements=[User.auth_subject])
    )
    session.commit()
    return session.scalars(select(User).where(User.auth_subject == identity.subject)).one()


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    session: Annotated[Session, Depends(get_session)],
) -> User:
    if credentials is None:
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "not_authenticated")
    return get_or_create_user(session, decode_token(credentials.credentials))


def get_token_claims(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> TokenIdentity:
    if credentials is None:
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "not_authenticated")
    return decode_token(credentials.credentials)


def get_verified_email(identity: Annotated[TokenIdentity, Depends(get_token_claims)]) -> str | None:
    """The address Hanko says this user has proven to own. `User.email` is not enough for
    decisions that depend on owning an address: it is copied from the token unconditionally."""
    return identity.email if identity.email_verified else None


CurrentUser = Annotated[User, Depends(get_current_user)]
TokenClaims = Annotated[TokenIdentity, Depends(get_token_claims)]
VerifiedEmail = Annotated[str | None, Depends(get_verified_email)]
DbSession = Annotated[Session, Depends(get_session)]
