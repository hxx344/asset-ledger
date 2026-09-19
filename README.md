# 资产统计

个人资产面板，支持 Excel 历史导入、Virtual 实时报价、Bybit / Aster 只读账户同步和手动估值。公开仓库仅含虚构示例数据，不含个人资产记录或凭据；原表中的未来预填记录保留但不参与历史曲线。

本仓库交付代码，不自动发布站点。当前运行环境为 React / Vinext + Cloudflare Worker / D1；本地开发使用模拟登录。生产身份验证仍依赖平台转发的可信登录信息，不能直接作为普通 Node 服务运行。

## 使用

- Virtual：优先使用 CoinGecko 美元单价，失败时使用 Coinbase 美元兑换率的倒数作为备用报价；持仓数量手动编辑。CoinGecko 展示行情时间，Coinbase 无原始行情时间，明确标为获取时间。
- Bybit：HMAC API Key，验证 `readOnly = 1` 后读取统一账户 `totalEquity` 与资金账户余额。统一账户含未实现盈亏，不再叠加钱包余额、保证金、借款或持仓名义价值。子账户与 Earn 不在当前范围。
- Aster：使用已有的只读 HMAC API Key/Secret（V1），读取合约账户每种资产的 `marginBalance`，含未实现盈亏；可选择读取现货的 `free + locked`。不包含质押。Aster `canTrade` 是账户状态，不能用它判断密钥是否只读；密钥权限须在交易所设置，本程序固定仅调用只读 GET 路由。
- 其余项目：维持原数量和估值，支持手动编辑。表里的“资产”多为美元合计，不按项目名称误匹配成同名代币。
- 汇率：沿用导入表格的手动汇率，可修改。
- 页面打开且前台在线时每 60 秒更新；服务端 30 秒去重。每天保存最近一次刷新或编辑的快照。页面关闭期间不补造数据，也没有后台定时任务。
- 接口失败保留原值及原成功时间；未知币种、缺失字段、超时、权限不足不会当作零。积分及 NFT 保留预估口径。历史资产变化含资金进出，不能视为投资收益。

## 数据与访问

React / Vinext + Cloudflare Worker，D1 保存资产、连接和快照。Sites 私人站点负责登录与访问限制。每个数据库操作按登录用户隔离；接口禁用响应缓存，写入要求同源。API Secret 使用 AES-GCM 加密保存，`CREDENTIAL_KEY` 通过 Sites secret 注入，不发送到浏览器。原表快照只在认证后的服务端返回，不导入客户端代码。

`CREDENTIAL_KEY` 是 32 字节随机值的 64 位十六进制表示。保持该值不变；更换后旧连接需重新配置。开发环境使用忽略的 `.env` 和 `.dev.vars`。不提交这两个文件或真实 API Key。

## 开发与验证

Node 22.13+。`npm ci` 安装依赖并从 `lib/example-ledger.json` 生成被 Git 忽略的 `lib/imported-ledger.json`；已有个人导入文件不会被覆盖。使用 `npm run dev` 启动本地服务；`npm test` 检查净权益、签名、只读路径、非法数值和过期行情；`npx tsc --noEmit` 检查类型；`npm run build` 生成 Worker，不会发布。

导入自己的表格：先安装 Python 的 `openpyxl`，然后在仓库根目录运行 `python scripts/import-workbook.py "资产统计.xlsx" 2026-09-19`，日期参数为统计起始日。生成的个人数据和 Excel 文件均已加入忽略规则。请在首次初始化数据库之前导入；已有数据库不会因为替换导入文件而被覆盖。

持久化 schema 在 `db/schema.ts`，迁移在 `drizzle/`。本地首次运行前，执行 `npx wrangler d1 execute DB --local --config wrangler.local.json --persist-to .wrangler/state --file drizzle/0000_worried_goblin_queen.sql` 初始化表结构。修改 schema 时运行 `npm run db:generate` 并检查生成的 SQL。开发环境使用本地 D1。

原表读取脚本：`scripts/import-workbook.py <xlsx-path> <as-of-date>`（需要 openpyxl，只读）。它核对当前基准合计，保留历史合计差异和同日不同版本。实际源表不在仓库内。

## 官方接口资料

- [Bybit 钱包余额](https://bybit-exchange.github.io/docs/v5/account/wallet-balance)
- [Bybit 只读权限](https://bybit-exchange.github.io/docs/v5/user/apikey-info)
- [Bybit 资金账户](https://bybit-exchange.github.io/docs/v5/asset/balance/all-balance)
- [Aster HMAC 合约 API](https://github.com/asterdex/api-docs/blob/master/V1%28Legacy%29/EN/aster-finance-futures-api.md)
- [Aster HMAC 现货 API](https://github.com/asterdex/api-docs/blob/master/V1%28Legacy%29/EN/aster-finance-spot-api.md)
- [CoinGecko simple price](https://docs.coingecko.com/reference/simple-price)
- [Coinbase 备用报价](https://docs.cdp.coinbase.com/coinbase-app/track-apis/exchange-rates)

真实 Bybit / Aster 账户必须由用户在连接设置填写只读凭据后验证。自动化测试使用合成数据，不代表真实账户已经接通。
