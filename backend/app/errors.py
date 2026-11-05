"""API errors carry a stable machine-readable code in `detail`. The frontend translates it."""

from fastapi import HTTPException


class ApiError(HTTPException):
    def __init__(self, status_code: int, code: str) -> None:
        headers = {"WWW-Authenticate": "Bearer"} if status_code == 401 else None
        super().__init__(status_code=status_code, detail=code, headers=headers)
