from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload
from sqlmodel import Session, SQLModel, select
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from app.db import engine, get_session
from app.domain import RuleError, assert_can_log_peak, assert_can_set_status, latest_peak
from app.models import CookLog, Kettle, StoveSeal, StoveSealLog, User, Workshop, utcnow
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


def require_admin(user: User | None):
    if user is None:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    if user.role != "admin":
        return JSONResponse({"detail": "只有管理员能升旗降旗"}, status_code=403)
    return None


def load_kettle(session: Session, kettle_id: int) -> Kettle | None:
    return session.exec(
        select(Kettle).where(Kettle.id == kettle_id).options(selectinload(Kettle.cooks))
    ).first()


def load_seal(session: Session, workshop_id: int) -> StoveSeal | None:
    return session.exec(
        select(StoveSeal).where(StoveSeal.workshop_id == workshop_id)
    ).first()


def seal_raised(session: Session, workshop_id: int) -> bool:
    seal = load_seal(session, workshop_id)
    return bool(seal and seal.raised)


def kettle_json(kettle: Kettle) -> dict:
    return {
        "id": kettle.id,
        "code": kettle.code,
        "status": kettle.status,
        "bench": kettle.bench,
        "workshopId": kettle.workshop_id,
        "latestPeakC": latest_peak(kettle),
        "cookCount": len(kettle.cooks or []),
    }


def workshop_json(shop: Workshop, seal: StoveSeal | None) -> dict:
    return {
        "id": shop.id,
        "name": shop.name,
        "alley": shop.alley,
        "sealRaised": bool(seal and seal.raised),
        "changedBy": seal.changed_by if seal else None,
        "changedAt": seal.changed_at.isoformat() if seal else None,
    }


def seal_log_json(log: StoveSealLog) -> dict:
    return {
        "id": log.id,
        "workshopId": log.workshop_id,
        "workshopName": log.workshop_name,
        "raised": log.raised,
        "changedBy": log.changed_by,
        "changedAt": log.changed_at.isoformat(),
    }


async def health(request: Request):
    return JSONResponse({"status": "ok", "service": "GlueKettle"})


async def login(request: Request):
    body = await request.json()
    with get_session() as session:
        user = session.exec(select(User).where(User.username == body.get("username", ""))).first()
        if user is None or not verify_password(body.get("password", ""), user.password_hash):
            return JSONResponse({"detail": "用户名或密码错误"}, status_code=401)
        return JSONResponse(
            {
                "access_token": make_token(user.username),
                "user": {"username": user.username, "role": user.role},
            }
        )


async def me(request: Request):
    user = await current_user(request)
    if user is None:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    return JSONResponse({"username": user.username, "role": user.role})


async def list_workshops(request: Request):
    user = await current_user(request)
    if user is None:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    with get_session() as session:
        shops = session.exec(select(Workshop).order_by(Workshop.id)).all()
        return JSONResponse(
            {"workshops": [workshop_json(s, load_seal(session, s.id)) for s in shops]}
        )


async def seal_logs(request: Request):
    user = await current_user(request)
    if user is None:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    stmt = select(StoveSealLog).order_by(StoveSealLog.changed_at.desc(), StoveSealLog.id.desc())
    workshop_id = request.query_params.get("workshop_id")
    if workshop_id:
        try:
            stmt = stmt.where(StoveSealLog.workshop_id == int(workshop_id))
        except ValueError:
            return JSONResponse({"detail": "坊号无效"}, status_code=400)
    with get_session() as session:
        logs = session.exec(stmt.limit(200)).all()
        return JSONResponse({"logs": [seal_log_json(log) for log in logs]})


async def set_seal(request: Request):
    user = await current_user(request)
    denied = require_admin(user)
    if denied is not None:
        return denied
    workshop_id = int(request.path_params["workshop_id"])
    body = await request.json()
    raised = bool(body.get("raised"))
    # 同坊并发改旗：先对坊行加行锁串行化，配合 workshop_id 唯一约束，
    # 两名主管几乎同时提交也只会留下一条现行记录（后提交者覆盖前版）。
    try:
        with get_session() as session:
            shop = session.exec(
                select(Workshop).where(Workshop.id == workshop_id).with_for_update()
            ).first()
            if shop is None:
                return JSONResponse({"detail": "熬胶坊不存在"}, status_code=404)
            seal = load_seal(session, workshop_id)
            if seal is None:
                seal = StoveSeal(workshop_id=workshop_id)
                session.add(seal)
            seal.raised = raised
            seal.changed_by = user.username
            seal.changed_at = utcnow()
            session.add(
                StoveSealLog(
                    workshop_id=workshop_id,
                    workshop_name=shop.name,
                    raised=raised,
                    changed_by=user.username,
                )
            )
            session.commit()
            session.refresh(seal)
            return JSONResponse(workshop_json(shop, seal))
    except IntegrityError:
        return JSONResponse({"detail": "封灶状态刚被改动，请刷新后重试"}, status_code=409)


async def board(request: Request):
    user = await current_user(request)
    if user is None:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    workshop_id = request.query_params.get("workshop_id")
    with get_session() as session:
        if workshop_id:
            try:
                shop = session.exec(
                    select(Workshop).where(Workshop.id == int(workshop_id))
                ).first()
            except ValueError:
                return JSONResponse({"detail": "坊号无效"}, status_code=400)
        else:
            shop = session.exec(select(Workshop).order_by(Workshop.id)).first()
        if shop is None:
            return JSONResponse({"detail": "尚无熬胶坊"}, status_code=404)
        kettles = session.exec(
            select(Kettle)
            .where(Kettle.workshop_id == shop.id)
            .options(selectinload(Kettle.cooks))
        ).all()
        loaded = sorted(kettles, key=lambda k: k.bench)
        seal = load_seal(session, shop.id)
        return JSONResponse(
            {
                "workshopId": shop.id,
                "workshop": shop.name,
                "alley": shop.alley,
                "sealRaised": bool(seal and seal.raised),
                "sealChangedBy": seal.changed_by if seal else None,
                "sealChangedAt": seal.changed_at.isoformat() if seal else None,
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
        # 封灶旗由服务端读取：升起时中文挡回，峰值不得入库。
        try:
            assert_can_log_peak(seal_raised(session, kettle.workshop_id))
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
        # 改锅态不看封灶旗，只认峰值门槛。
        try:
            assert_can_set_status(kettle, body.get("status", ""))
        except RuleError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=400)
        kettle.status = body.get("status")
        session.add(kettle)
        session.commit()
        kettle = load_kettle(session, kettle_id)
        return JSONResponse(kettle_json(kettle))


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
        Route("/api/workshops", list_workshops),
        Route("/api/workshops/{workshop_id:int}/seal", set_seal, methods=["POST"]),
        Route("/api/seal-logs", seal_logs),
        Route("/api/kettles/{kettle_id:int}/cooks", add_cook, methods=["POST"]),
        Route("/api/kettles/{kettle_id:int}/status", set_status, methods=["POST"]),
    ],
    middleware=[
        Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    ],
)
