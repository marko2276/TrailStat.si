"""trails with a loaded route, and where their elevation came from

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # The enums are VARCHAR with a CHECK constraint, so a new value means a new constraint.
    op.drop_constraint(op.f("ck_trails_trail_source"), "trails", type_="check")
    op.create_check_constraint(
        op.f("ck_trails_trail_source"), "trails", "source IN ('osm', 'manual', 'file')"
    )
    op.add_column(
        "trails",
        sa.Column(
            "elevation_source",
            sa.Enum(
                "dem",
                "file",
                name="elevation_source",
                native_enum=False,
                create_constraint=True,
                length=16,
            ),
            nullable=True,
        ),
    )
    # Until now only OSM imports got elevation data, always from the DEM.
    op.execute(
        "UPDATE trails SET elevation_source = 'dem' "
        "WHERE source = 'osm' AND elevation_gain_m IS NOT NULL"
    )


def downgrade() -> None:
    # Trails with a loaded route keep their measurements, as manual trails.
    op.execute("UPDATE trails SET source = 'manual' WHERE source = 'file'")
    op.drop_column("trails", "elevation_source")
    op.drop_constraint(op.f("ck_trails_trail_source"), "trails", type_="check")
    op.create_check_constraint(
        op.f("ck_trails_trail_source"), "trails", "source IN ('osm', 'manual')"
    )
