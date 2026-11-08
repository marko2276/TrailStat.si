"""the day each user last used the app, for the admin page's count of active users

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_seen_on", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "last_seen_on")
