from logging.config import fileConfig

from alembic import context
from geoalchemy2 import alembic_helpers
from sqlalchemy import Connection, text

import app.models  # noqa: F401  (registers the models on Base.metadata)
from app.db import Base, get_engine

if context.config.config_file_name is not None:
    fileConfig(context.config.config_file_name)


def include_name(name: str | None, type_: str, parent_names: object) -> bool:
    # spatial_ref_sys belongs to the PostGIS extension, not to our schema.
    return not (type_ == "table" and name == "spatial_ref_sys")


def run_on(connection: Connection) -> None:
    # The PostGIS image adds its topology and tiger schemas to the default search
    # path. Without this, autogenerate would treat their tables as ours and drop them.
    connection.execute(text("SET search_path TO public"))
    connection.commit()
    context.configure(
        connection=connection,
        target_metadata=Base.metadata,
        include_name=include_name,
        include_object=alembic_helpers.include_object,
        process_revision_directives=alembic_helpers.writer,
        render_item=alembic_helpers.render_item,
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    raise SystemExit("Offline migrations are not supported.")

# Tests pass in their own connection, to a separate database.
given_connection = context.config.attributes.get("connection")
if given_connection is not None:
    run_on(given_connection)
else:
    with get_engine().connect() as engine_connection:
        run_on(engine_connection)
