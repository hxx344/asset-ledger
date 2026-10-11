# Hub 只读仓位接口

`GET /api/hub/positions?schemaVersion=1` 使用 Asset 现有登录会话；响应始终 `Cache-Control: no-store`。交易所目录、Aster 账号名称、连接状态及读取凭据来自 Asset，接口不会导出密钥或钱包私钥。Hub 不需要维护另一份目录。

## 快照语义

- `unconfigured`：没有保存连接，所有产品均无快照。
- `loading`：首次读取已排队；接口立即返回，不等待交易所响应。
- `live`：成功读取完整范围。只有 `live` 且 `positions: []` 表示确认空仓。
- `stale`：最近成功快照超过 90 秒；仍可展示，但必须保留过期提示。
- `error`：读取、分页、结构验证或解密失败；保留上次完整快照及原 `fetchedAt`，没有旧快照时仍不表示空仓。
- `unsupported`：该产品尚未接入；不能据此推断持仓。

刷新 TTL 为 30 秒，全进程最多同时运行 3 个产品读取任务，每个任务最多 25 秒。单个 HTTP 请求最多 10 秒，Var Python 请求最多 23 秒。每个账户/产品只执行一个刷新；旧快照只在完整请求全部成功后替换。Bybit 游标重复、缺失、页数超限或后续页失败都会使该产品本轮失败。

缓存按所有者、账号、产品及密文指纹隔离。每次 GET 都读取当前连接；更换或断开凭据立即隔离旧数据。后台任务在开始及发布结果前重新核对密文指纹，拒绝迟到结果。缓存仅保留进程内标准化结果，重启后重新读取。

## 产品覆盖与单位

| 交易所 | 产品范围 | 数量、金额口径 |
| --- | --- | --- |
| Binance | 普通 UM、普通 CM、Portfolio Margin UM、Portfolio Margin CM，各自独立状态；期权暂未接入 | UM 数量为基础资产；CM 数量为张数，合约面值取官方 instruments，名义金额为张数×面值，币本位盈亏保留结算币种 |
| Bybit | USDT/USDC 线性、反向合约、期权，分别读取所有游标页；沿用 Asset 的 global/nl/tr/kz/ge/ae/eu 地区 | 线性/期权数量取基础资产，反向数量取报价币；positionValue 的币种在反向产品为基础资产，其余为报价币；盈亏保留 settleCoin |
| OKX | SWAP、FUTURES；OPTION 与 MARGIN 暂未接入 | 数量为张数；contractSize 为 ctVal×ctMult，quantityUnit 标明 ctValCcy/张；notionalUsd 标记 USD，upl 标记 settleCcy |
| Aster | Asset 管理的每个 API Pro 账号分别读取合约仓位 | 基础资产数量与官方交易对元数据；现货余额不伪装为合约仓位 |
| Variational | 当前 Omni `/api/positions` 返回的 perpetual_future、perpetual_rwa_future、perpetual_cfd、swap | qty 正负决定多空，展示绝对数量；基础资产单位，金额使用 instrument.settlement_asset；未知结构/产品失败，不静默丢弃 |

账号必须具备对应产品的读取权限；未开通产品、账号模式不适用或地区接口拒绝访问会显示该产品的读取错误，不将其报告为空仓。只读密钥仍遵循 Asset 现有约束：Binance、Bybit 和 OKX 首先读取并验证权限。Aster 使用已有 API Pro 钱包，服务器网络出口仅允许固定 GET 仓位路径和公共产品元数据路径。

所有金额及数量使用十进制字符串，缺失字段为 `null`，不通过 JavaScript 浮点数转换。不同币种不合并，不将 USDC/USDT 视作 USD。`sourceUpdatedAt` 为交易所仓位更新时间；`fetchedAt` 为完整快照本次获取时间，两者用途不同。仓位稳定 ID 为不可逆摘要，不包含账号、钱包、池子等原始标识。

## 接口依据（2026-10-12 核对）

- [Binance UM positionRisk](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Position-Information-V3)、[CM positionRisk](https://developers.binance.com/docs/derivatives/coin-margined-futures/trade/rest-api/Position-Information)、[PM UM](https://developers.binance.com/docs/derivatives/portfolio-margin/account/Query-UM-Position-Information)、[PM CM](https://developers.binance.com/docs/derivatives/portfolio-margin/account/Query-CM-Position-Information)。
- [Bybit Position Info](https://bybit-exchange.github.io/docs/v5/position)、[Instrument Info](https://bybit-exchange.github.io/docs/v5/market/instrument)。
- [OKX API v5](https://www.okx.com/docs-v5/en/)、[OKX 合约面值与乘数说明](https://www.okx.com/en-us/help/how-can-i-do-derivatives-trading-with-the-jupyter-notebook)。
- [Aster 官方 Futures V3](https://github.com/asterdex/api-docs/blob/master/V3(Recommended)/EN/aster-finance-futures-api-v3.md)。
- Variational 个人仓位没有公开版本化 API 契约；依据核对日当前官方 Omni 客户端：[positions store](https://omni.variational.io/_app/immutable/chunks/h53ldYbh.js)、[仓位展示适配器](https://omni.variational.io/_app/immutable/chunks/VdRjQSXS.js)。客户端读取 `/api/positions` 顶层数组，使用 `position_info.qty/avg_entry_price/updated_at/instrument`、`price_info.price`、`value`、`upnl`、`estimated_liquidation_price`。继续复用隔离 Python 客户端和 Cookie；不使用诊断结果作为认证证明，不调用下单或报价接口。前端静态文件名可能随版本改变，服务结构变化会显式报错。

验证使用合成凭据、离线交易所响应、内存数据库与模拟子进程；没有请求用户真实账户。覆盖多空、精度、分页完整性、单位、只读签名、失败保留、凭据替换与断开竞态、超时和错误净化。
