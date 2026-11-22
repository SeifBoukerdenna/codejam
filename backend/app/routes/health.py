"""GET /api/health/slis: the system health page (health.py does the measuring)."""

from fastapi import APIRouter, Depends

from app import health
from app.auth import current_user, require
from app.db import get_conn

router = APIRouter(prefix="/api")


@router.get("/health/slis")
def service_levels(conn=Depends(get_conn), user=Depends(current_user)):
    require(conn, user, "health.view")
    return health.slis(conn)
