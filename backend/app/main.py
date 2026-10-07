from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload
from sqlmodel import SQLModel, select

from app.db import engine, get_session
from app.domain import RuleError, assert_can_log_peak, assert_can_set_status, latest_peak
from app.models import CookLog, Kettle, SealFlag, User, Workshop, utcnow
from app.security import make_token, parse_token, verify_password
from app.seed import seed_demo


async def current_user(request: Request) -> User | None:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return None
    username = parse_token(header.split(" ", 1)[1])
    if not username:
        return None
    with get_session() as session:
        return session.exec(select(User).where(User.username == username)).first()


def load_kettle(session, kettle_id: int) -> Kettle | None:
    return session.exec(
        select(Kettle).where(Kettle.id == kettle_id).options(selectinload(Kettle.cooks))
    ).first()


def kettle_json(kettle: Kettle) -> dict:
    return {
        "id": kettle.id,
        "code": kettle.code,
        "status": kettle.status,
        "bench": kettle.bench,
        "latestPeakC": latest_peak(kettle),
        "cookCount": len(kettle.cooks or []),
    }


def load_seal(session, workshop_id: int) -> SealFlag | None:
    return session.exec(select(SealFlag).where(SealFlag.workshop_id == workshop_id)).first()


def seal_json(shop: Workshop, flag: SealFlag | None) -> dict:
    return {
        "workshopId": shop.id,
        "workshop": shop.name,
        "alley": shop.alley,
        "raised": flag.raised if flag else None,
        "changedBy": flag.changed_by if flag else None,
        "changedAt": flag.changed_at.isoformat() if flag else None,
    }


def apply_seal(session, workshop_id: int, raised: bool, username: str) -> SealFlag:
    """升旗/降旗：每坊只留一版。并发抢建时唯一约束兜底，撞约束翻为更新。"""
    flag = load_seal(session, workshop_id)
    if flag is None:
        flag = SealFlag(workshop_id=workshop_id, raised=raised, changed_by=username)
        session.add(flag)
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            flag = load_seal(session, workshop_id)
        else:
            return flag
    flag.raised = raised
    flag.changed_by = username
    flag.changed_at = utcnow()
    session.add(flag)
    session.commit()
    return flag


async def health(request: Request):
    return JSONResponse({"status": "ok", "service": "GlueKettle"})


async def login(request: Request):
    body = await request.json()
    with get_session() as session:
        user = session.exec(select(User).where(User.username == body.get("username", ""))).first()
        if user is None or not verify_password(body.get("password", ""), user.password_hash):
            return JSONResponse({"detail": "用户名或密码错误"}, status_code=401)
        return JSONResponse(
            {"access_token": make_token(user.username), "user": {"username": user.username, "role": user.role}}
        )


async def me(request: Request):
    user = await current_user(request)
    if user is None:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    return JSONResponse({"username": user.username, "role": user.role})


async def board(request: Request):
    user = await current_user(request)
    if user is None:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    with get_session() as session:
        shop = session.exec(select(Workshop).order_by(Workshop.id)).first()
        if shop is None:
            return JSONResponse({"detail": "尚无熬胶坊"}, status_code=404)
        kettles = session.exec(
            select(Kettle)
            .where(Kettle.workshop_id == shop.id)
            .options(selectinload(Kettle.cooks))
        ).all()
        loaded = sorted(kettles, key=lambda k: k.bench)
        flag = load_seal(session, shop.id)
        return JSONResponse(
            {
                "workshop": shop.name,
                "alley": shop.alley,
                "sealRaised": bool(flag and flag.raised),
                "kettles": [kettle_json(k) for k in loaded],
            }
        )


async def add_cook(request: Request):
    user = await current_user(request)
    if user is None:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    kettle_id = int(request.path_params["kettle_id"])
    body = await request.json()
    try:
        peak = float(body.get("peakTempC"))
    except (TypeError, ValueError):
        return JSONResponse({"detail": "峰值温度必须是数字"}, status_code=400)
    with get_session() as session:
        kettle = load_kettle(session, kettle_id)
        if kettle is None:
            return JSONResponse({"detail": "锅不存在"}, status_code=404)
        try:
            assert_can_log_peak(load_seal(session, kettle.workshop_id))
        except RuleError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=400)
        session.add(CookLog(kettle_id=kettle.id, peak_temp_c=peak, operator=user.username))
        session.commit()
        kettle = load_kettle(session, kettle_id)
        return JSONResponse(kettle_json(kettle))


async def set_status(request: Request):
    user = await current_user(request)
    if user is None:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    kettle_id = int(request.path_params["kettle_id"])
    body = await request.json()
    with get_session() as session:
        kettle = load_kettle(session, kettle_id)
        if kettle is None:
            return JSONResponse({"detail": "锅不存在"}, status_code=404)
        try:
            assert_can_set_status(kettle, body.get("status", ""))
        except RuleError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=400)
        kettle.status = body.get("status")
        session.add(kettle)
        session.commit()
        kettle = load_kettle(session, kettle_id)
        return JSONResponse(kettle_json(kettle))


async def list_seals(request: Request):
    user = await current_user(request)
    if user is None:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    workshop_id = request.query_params.get("workshop_id")
    with get_session() as session:
        shops = session.exec(select(Workshop).order_by(Workshop.id)).all()
        if workshop_id:
            try:
                wid = int(workshop_id)
            except ValueError:
                return JSONResponse({"detail": "坊编号必须是数字"}, status_code=400)
            shops = [s for s in shops if s.id == wid]
        flags = {f.workshop_id: f for f in session.exec(select(SealFlag)).all()}
        return JSONResponse({"seals": [seal_json(s, flags.get(s.id)) for s in shops]})


async def set_seal(request: Request):
    user = await current_user(request)
    if user is None:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    if user.role != "admin":
        return JSONResponse({"detail": "只有管理员能升旗降旗"}, status_code=403)
    workshop_id = int(request.path_params["workshop_id"])
    body = await request.json()
    raised = bool(body.get("raised"))
    with get_session() as session:
        shop = session.get(Workshop, workshop_id)
        if shop is None:
            return JSONResponse({"detail": "坊不存在"}, status_code=404)
        flag = apply_seal(session, workshop_id, raised, user.username)
        return JSONResponse(seal_json(shop, flag))


def init() -> None:
    SQLModel.metadata.create_all(engine)
    seed_demo()


init()

app = Starlette(
    routes=[
        Route("/api/health", health),
        Route("/api/auth/login", login, methods=["POST"]),
        Route("/api/auth/me", me),
        Route("/api/board", board),
        Route("/api/kettles/{kettle_id:int}/cooks", add_cook, methods=["POST"]),
        Route("/api/kettles/{kettle_id:int}/status", set_status, methods=["POST"]),
        Route("/api/seals", list_seals),
        Route("/api/seals/{workshop_id:int}", set_seal, methods=["PUT"]),
    ],
    middleware=[Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])],
)
