from logging.config import fileConfig

from alembic import context
from sqlalchemy import text

from app.db import Base, get_engine

if context.config.config_file_name is not None:
    fileConfig(context.config.config_file_name)


def include_name(name: str | None, type_: str, parent_names: object) -> bool:
    # spatial_ref_sys belongs to the PostGIS extension, not to our schema.
    return not (type_ == "table" and name == "spatial_ref_sys")


def run_migrations() -> None:
    with get_engine().connect() as connection:
        # The PostGIS image adds its topology and tiger schemas to the default search
        # path. Without this, autogenerate would treat their tables as ours and drop them.
        connection.execute(text("SET search_path TO public"))
        connection.commit()
        context.configure(
            connection=connection,
            target_metadata=Base.metadata,
            include_name=include_name,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    raise SystemExit("Offline migrations are not supported.")
run_migrations()
