# GlueKettle-01 · 骨巷熬胶坊

一排熬锅作业台。登录后是横向锅位，点锅登记煮胶峰值并改状态。前端是原生 JS，没有 React/Vue/Svelte。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Web API | Starlette 路由表（不是 FastAPI Depends） |
| 结构 | SQLModel 实体 + `domain.py` 门槛 |
| 数据 | SQLModel / SQLAlchemy · psycopg2 · PostgreSQL 15 |
| 前端 | 原生 ES Module · Vite 仅打包 |
| 部署 | Docker Compose |

## 路径与端口

- 前端：http://localhost:4790
- API：http://localhost:8790
- PostgreSQL：localhost:6190

## 演示账号

`admin` / `123456`，`worker` / `123456`

## 业务规则

- 锅不可标「已出胶」，除非最近一次煮胶峰值 **≥ 90℃**。规则在 `backend/app/domain.py`。
- **封灶旗**：每坊一面，现行记录每坊至多一条（`stoveseal.workshop_id` 唯一），升旗/降旗流水只追加（`stoveseallog`）。
  - 升旗后，该坊任何锅**登记峰值**都被挡下（中文提示，峰值不入库）；前端输入框与按钮同时置灰。
  - **改锅态不受封灶影响**；「已出胶」仍只认最近峰值 ≥ 90℃，封灶顶不掉这条门槛。
  - 只有管理员能升旗/降旗（`POST /api/workshops/{id}/seal`）；操作工进封灶台只读。
  - 顶栏在「锅位作业台」「封灶台」两个专页间切换；封灶台可升可降、按坊筛选改旗记录。
  - 同坊并发改旗：服务端对坊行加锁并依赖唯一约束，两名主管几乎同时提交也只留一版，随后登峰值按留下的版本判断。

## 快速启动

```bash
cd GlueKettle/GlueKettle-01
docker compose up --build
```
