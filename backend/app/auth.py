"""Authentication: validates Hanko session tokens (JWT) against Hanko's public keys.

TrailStat never sees passwords. Everything specific to the provider is in this module,
so another provider can be swapped in (see ADR 0003).
"""

import logging
from dataclasses import dataclass
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
    return jwt.PyJWKClient(url, cache_keys=True, lifespan=3600, timeout=10)


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
    if user is not None:
        if identity.email and identity.email != user.email:
            user.email = identity.email
            session.commit()
        return user

    email = identity.email or fetch_email_from_hanko(identity)
    # ON CONFLICT: the app's first requests after sign-up arrive in parallel.
    session.execute(
        insert(User)
        .values(
            auth_subject=identity.subject,
            email=email,
            display_name=email.split("@", 1)[0][:100],
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


def get_verified_email(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> str | None:
    """The address Hanko says this user has proven to own. `User.email` is not enough for
    decisions that depend on owning an address: it is copied from the token unconditionally."""
    if credentials is None:
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "not_authenticated")
    identity = decode_token(credentials.credentials)
    return identity.email if identity.email_verified else None


CurrentUser = Annotated[User, Depends(get_current_user)]
VerifiedEmail = Annotated[str | None, Depends(get_verified_email)]
DbSession = Annotated[Session, Depends(get_session)]
