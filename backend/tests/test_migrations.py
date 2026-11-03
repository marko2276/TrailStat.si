from alembic import command
from sqlalchemy import Engine

from tests.conftest import alembic_config


def test_models_match_migrations(test_engine: Engine) -> None:
    """Fails when a model changed without a migration, or autogenerate would drop something."""
    with test_engine.connect() as connection:
        command.check(alembic_config(connection))
