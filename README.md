# 资产统计

个人资产面板，支持 Excel 历史导入、Virtual 实时报价、Bybit / Binance / OKX / Aster / Variational 资产读取和手动估值。使用 Next.js、Node.js 24 和 SQLite，无需 Sites、Cloudflare 或外部数据库账号。公开仓库仅含虚构示例数据，不含真实资产记录和凭据。

## Var / Variational 资产

在“交易所连接”选择 **Var · Variational**，填写登录 [Omni](https://omni.variational.io/) 后浏览器 Cookie 中的 `vr-token` 值（不带 `vr-token=`，无需钱包私钥）。验证成功后加密保存；会话过期时在同一入口更新。该令牌是网页会话，并非交易所限制权限的只读 API Key；本账本只向固定官方地址发送资产 GET 请求，不执行交易、转账或提现，也不向工作台交易模块导出该令牌。

总额采用 Omni `GET /api/portfolio?compute_margin=true` 返回的顶层 `balance`，即网页显示的 Portfolio Value，按 USDC/USD 报价换算美元；不再次叠加未实现盈亏、保证金或子账户分项，不使用 Var 策略的模拟权益。现有 `var` 或 `variational` 资产行会原位更新，首次连接没有对应行才新增；失败和断开保留旧估值及原更新时间，重新导入原表保留已同步资产。

该接口是官方网页内部接口，当前[公开 API 文档](https://docs.variational.io/technical-documentation/api)仅列市场统计。账户字段依据 [Omni 客户端](https://omni.variational.io/_app/immutable/chunks/_rMjg3I8.js)和[资产页面](https://omni.variational.io/_app/immutable/nodes/12.DLyg7qxW.js)的读取方式核实（2026-10-10）；[官方账户说明](https://help.variational.io/en/articles/14765726-making-a-trade-on-omni)定义 Portfolio Value 为账户总价值。接口变化、数据缺失或会话拒绝访问都会报错保留旧值，不填零。接口没有已确认的资产源时间，页面估值时间取账户获取时间与汇率时间的较早者；汇率单独读取 USDC/USD，不依赖 VIRTUAL 行情成功。

连接和后台刷新会区分以下失败原因，页面只显示固定诊断，不显示响应正文或凭据：

- **Cloudflare 浏览器验证**：官方响应带有 `cf-mitigated: challenge`，优先于 HTTP 状态判断；这不能证明令牌失效。当前服务器客户端无法完成该验证，更换令牌不保证恢复后台读取。
- **HTTP 401**：官网未接受当前会话，请确认 Omni 已登录并更新 `vr-token`。
- **HTTP 403**：官网拒绝服务器访问，尚不能确认是令牌失效；不会仅凭 403 或 Cloudflare 服务标识推断为浏览器验证。
- **异常网页或超时**：未收到可用账户数据，保留旧估值和原更新时间，后续刷新可重试。

请求格式已按 [Omni 请求封装](https://omni.variational.io/_app/immutable/chunks/B2Dt0Djp.js)补齐 JSON 内容类型；没有添加浏览器依赖，也不声称补齐请求头可以解除 Cloudflare 验证。账户是否能够持续从服务器读取，仍以部署端携带有效会话的实际结果为准。

本次开发验证使用合成账户响应，实际账户需填写会话后在页面验证。

## 一键部署

支持 Ubuntu 22.04 / 24.04、Debian 12 / 13，amd64 / arm64，需 systemd。默认安装 CI 预先构建并明确发布的正式运行包，服务器不执行 npm 安装或 Next 构建；显式源码构建模式仍建议至少 2 核、4 GB 内存和 3 GB 可用磁盘。

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/asset-ledger/main/install.sh | sudo bash
```

自动准备 Node.js、下载并校验对应架构的 CI 运行包、生成登录密码、初始化 SQLite 并注册开机自启服务。首次安装仅监听服务器本机 `127.0.0.1:5678`，通过 SSH 隧道访问，使用终端显示的独立登录密码进入账本。服务器只需允许现有 SSH 连接，无需对公网开放 5678；脚本不修改 SSH 服务或防火墙规则。制品发布和源码后备模式见 [CI 运行包部署](docs/ci-release.md)。

`main` CI 全部通过后，只发布 `deploy-<完整提交号>` 候选 Release（`prerelease`），不改变当前正式版。发布者在 GitHub Actions 选择 **[Publish stable release](.github/workflows/promote-release.yml)**，分支选 `main`，在 `commit` 中填写已通过本仓库 CI 的完整 40 位提交 SHA 后运行；核验清单和部署包后，候选才晋级为最新正式版。默认安装及工作台前端更新只使用正式版，未晋级的候选不会自动安装。

已部署的服务切换为 SSH 隧道访问、端口 5678（在服务器执行，保留数据、密码和加密配置）：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/asset-ledger/main/install.sh | sudo bash -s -- --local --port 5678
```

然后在**自己的电脑**上打开 PowerShell 或终端，替换用户名和服务器 IP 后执行：

```bash
ssh -N -L 127.0.0.1:5678:127.0.0.1:5678 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 用户名@服务器IP
```

保持这个 SSH 窗口运行，在本机浏览器打开 `http://127.0.0.1:5678`。输入 SSH 密码时终端不会显示字符；密钥登录沿用你已有的 SSH 配置。页面仍使用安装时生成的账本登录密码。电脑与服务器之间的数据通过 SSH 加密传输，关闭隧道后本机地址不再可用。

SSH 不是默认 22 端口时，在命令中加 `-p SSH端口`；指定密钥可加 `-i 密钥文件路径`。若本机 5678 已被占用，将 `-L` 改为 `127.0.0.1:5679:127.0.0.1:5678`，浏览器改访问 `http://127.0.0.1:5679`。

自定义端口：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/asset-ledger/main/install.sh | sudo bash -s -- --port 8080
```

**升级再次执行同一条命令。** 未指定端口和 `--local` 时保留原端口及监听地址，所以旧版公网监听需要显式加 `--local` 切换；保留密码、加密密钥、资产和历史。运行内容和配置未变且服务健康时跳过归档下载、依赖安装、构建、备份和重启；只更新 README、docs、tests、CI 或安装器不会重新下载运行包或重启。端口、监听地址或 systemd 配置变化复用已有产物，仅应用配置并恢复服务。日志分别显示实际运行产物的提交和已检查的部署提交，文档提交不会冒充运行版本。

CI 在 x64 和 ARM64 原生环境共同构建 Next 页面、API 路由及服务端逻辑，打包 standalone、静态资源和数据库迁移，并启动解包后的服务验证。服务器校验包后部署。需要现场构建时，将命令末尾改为 `sudo env PROJECT_DEPLOY_MODE=source bash`，或使用 `--rebuild` 强制源码重建；源码模式继续复用独立依赖副本及按环境分区的 Next 缓存。

每次部署即时检查可用磁盘及 inode。新版本先完成下载、校验和解包，再停止旧服务并备份数据库；启动检查失败时恢复旧版本、端口和数据库。运行代码归 root 所有，服务用户只读。旧源码安装迁移到 CI 包时保留现有配置和数据。

安装器自动保留当前版本和一份成功回退版本，清理其他已识别旧版本及失败构建。实际运行目录、安装脚本所在目录、数据目录、未知文件、符号链接和挂载目录受到保护，因此特殊情况下保留数量可以超过两份。构建和停服备份前检查可用容量及 inode；不足时先回收可重建的 npm / webpack 缓存，仍不足就停止，原服务继续运行。

部署备份位于 `/opt/asset-ledger/backups/`，默认保留**最近 7 份完整备份，另加保留版本回滚所需的备份**。追加 `--backup-keep 14` 可修改并保存保留数量（1–365）。只有安装器标记的备份，或符合旧安装器完整文件结构的时间戳备份，才会自动回收；`/var/lib/asset-ledger/backups/` 下的业务导入备份不受此规则影响。

磁盘已满时可先只清理，不下载依赖、不构建、不重启服务：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/asset-ledger/main/install.sh | sudo bash -s -- --cleanup
```

需要新版本时先清理旧版本，成功切换后再收紧保留范围；应用和配置未变的快速路径跳过目录清理。清理后仍不足时，根据提示释放其他文件或扩容，再重复升级命令。

首次安装可导入已上传到服务器的原表：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/asset-ledger/main/install.sh | sudo bash -s -- --data-file /root/资产统计.xlsx
```

也支持导入脚本生成的 `.json`。首次未提供文件时使用示例数据，页面会明确提示“当前为示例数据，尚未导入你的原表”。升级只更新程序，不会把公开仓库的示例或本地文件覆盖到已有数据库。

### 已经启动但只有示例数据

在服务器上执行上面的升级命令，然后通过 SSH 隧道打开账本，点击 **导入原表数据**，选择从原表生成的 JSON 文件，核对资产条数、历史期数和起始日期后导入。文件直接从本机浏览器上传到自己的账本，无需先传到服务器或提交 GitHub。

导入文件可在本机用下文的 Python 命令生成；它保留原表历史、单元格位置和公式文本，不执行公式。页面只接受该格式的 JSON（最多 5 MB），不能直接选择 Excel 文件。

导入时会替换未修改的示例资产，保留已改过的数量、手动估值和汇率，以及已有 API 连接和同步余额。改过但与原表不匹配的示例行会额外保留，预览会列出这些项目。旧示例快照保留在历史记录，标记为“导入前示例记录”，不参与真实资产曲线。完整数据库备份位于 `/var/lib/asset-ledger/backups/before-import-*.sqlite`。

重复提交同一份文件不会覆盖后续修改。已有原表的账本不接受另一份文件覆盖；`--data-file` 仍仅适用于首次安装。

| 项目 | 位置 / 命令 |
| --- | --- |
| 服务状态 | `sudo systemctl status asset-ledger` |
| 查看日志 | `sudo journalctl -u asset-ledger -n 100` |
| 重启 / 停止 | `sudo systemctl restart asset-ledger` / `sudo systemctl stop asset-ledger` |
| 数据、历史与加密凭据 | `/var/lib/asset-ledger/ledger.sqlite` |
| 登录和加密配置 | `/var/lib/asset-ledger/config.json` |
| 当前版本 | `/opt/asset-ledger/current` |
| 端口设置 | `/opt/asset-ledger/deploy.env`，推荐通过 `--port` 修改 |

忘记密码时重置（保留交易所加密密钥，旧会话失效）：

```bash
sudo -u asset-ledger env ASSET_DATA_DIR=/var/lib/asset-ledger bash -c 'exec /opt/asset-ledger/runtime/node-v24.15.0-linux-$( [ "$(uname -m)" = x86_64 ] && echo x64 || echo arm64 )/bin/node "$(readlink -f /opt/asset-ledger/current/scripts/configure.mjs)" --reset-password'
```

命令会显示新密码，请保存并更新聚合工作台中 Asset Ledger 的登录密码。这里以服务用户解析 `current` 的实际路径，兼容旧版本中经目录链接运行重置脚本时直接退出、没有输出的问题；无需先升级。原资产数据与交易所加密密钥保留。

若曾通过 systemd override 设置过 `PUBLIC_ORIGIN`，切换 SSH 隧道时应移除该设置并重启服务，恢复按本机访问地址校验来源。升级会保留已有 override。

## 数据口径

- Virtual：优先使用 CoinGecko 美元报价，失败时改用 Coinbase 美元兑换率倒数；分别标明行情时间或获取时间。数量手动维护。
- Bybit：只读 HMAC API，验证 `readOnly = 1` 后读取统一账户 `totalEquity` 和资金账户余额。包含未实现盈亏，不重复累加保证金或持仓名义价值；不含子账户及 Earn。
- Binance：国际站只读 HMAC API，先检查 `/sapi/v1/account/apiRestrictions` 的读取及写入权限，再读取 `/sapi/v1/asset/wallet/balance?quoteAsset=USDT` 返回的各钱包折合余额，按 USDT/USD 汇率换算为美元。展示为“钱包资产估值”，明细中的 USDT 是估值单位，不是实际 USDT 持仓。范围以接口返回的钱包为准，不额外累加现货、合约或持仓名义价值，不额外汇总子账户及未返回的产品；不承诺包含全部未实现盈亏。
- Aster：API Pro 钱包地址（signer）+ 对应私钥，使用 V3 EIP-712 签名。读取 `/fapi/v3/accountWithJoinMargin` 的合约 `marginBalance`，可选 `/api/v3/account` 的现货 `free + locked`。不含质押；程序只允许这两个余额查询 GET 路由，不开放交易、划转或提现功能。
- USD/CNY：随资产刷新自动获取 Coinbase 当前汇率（直接使用每美元对应人民币数量）；失败时使用 Frankfurter 的 ECB 日度参考汇率。页面标明来源及获取时间 / 报价日期，不把日度参考标成逐笔实时报价。两者均失败则保留旧值及原时间，并提示失败；汇率失败不阻止交易所同步。临时手动备用值会在下次自动获取成功后被替换，历史快照保留当时汇率。
- 其他资产保留原值，支持手动编辑；不把项目名误当作同名代币，积分和 NFT 保留预估口径。
- 页面打开且前台在线时每 60 秒刷新，每天保存最近一次刷新或编辑。页面关闭时没有后台定时任务。
- 接口失败保留旧值及原时间，不用零覆盖失败结果。资产变化含资金进出，不能视为投资收益。未来预填记录不参与历史曲线。

Bybit / Binance API Secret 和 Aster API 钱包私钥使用 AES-GCM 加密，登录密码采用加盐 scrypt。会话 Cookie 为 HttpOnly，接口验证登录和写入来源。数据库、配置、Excel 和导入数据均被 Git 忽略。备份或迁移应同时保留数据库及 `config.json`，否则无法解密旧连接。

## Binance 只读连接

在「交易所连接 → Binance → 连接账户」填写 Binance 国际站的 HMAC **API Key** 和 **API Secret**。开启读取权限，关闭交易、划转、提现及其他写入权限；程序会拒绝缺少读取权限或存在写入权限的密钥。仅支持国际站，不支持 Binance.US，也不接受 RSA / Ed25519 密钥。

服务端完成权限与钱包余额验证后才加密保存连接，Secret 不返回浏览器、不写入日志。首次连接成功时复用已有的 Binance 手动资产行，没有时新增一条；更新连接和重新连接复用该记录。未连接或首次验证失败不会新增账本行。连接更新失败保留原连接与估值，同步失败保留余额及原成功时间；“断开并保留估值”删除凭据并保留最后估值，历史记录不变。

当前使用 Binance 钱包汇总接口提供的估值口径；可在资产明细核对各钱包折合 USDT 余额和美元价值。自动化测试使用合成响应，不能替代真实账户对钱包覆盖范围、账户权限和网络可达性的验证。真实连接需在自己的账本页面验证，勿将真实凭据写入仓库或测试配置。

## Aster API Pro 连接

在「交易所连接 → 新增 Aster 账号」填写账号名称、API Pro 页面生成的 **API 钱包地址**和**对应私钥**，可选择同时同步现货。不需要主钱包私钥。服务端先校验地址与私钥匹配，再读取账户；验证成功后加密保存。私钥不返回浏览器、不写入日志，也不作为请求参数发送给交易所。

最多支持 10 个 Aster 账号，各自保存余额、同步时间和错误；资产明细中的 Aster 为所有账号净权益之和，展开可按账号核对。升级自动保留原连接为“默认账号”，不需要重填；首次连接替换原表估值。某个账号失败只保留该账号旧值，其余继续更新，汇总时间取最旧账号时间。

“更新连接”可修改名称、凭据和现货范围；“断开并保留估值”删除私钥并保留余额；“移除账号”删除连接并从当前汇总扣除其余额，过去日期的快照不变。移除最后一个账号后 Aster 当前估值为零。相同 API 钱包不能重复添加；不同 API 钱包可能指向同一实际账户，系统不能识别这种重复，请每个实际账户只添加一次，更换钱包使用“更新连接”。新增或移除账号不是出入金，系统不会自动生成出金记录。

签名采用官方 V3 的 `AsterSignTransaction` 域、`chainId = 1666`、`Message(string msg)`；签名内容为实际发送的 URL 编码查询串，包含唯一微秒 `nonce` 和 `signer`。合约与现货使用不同 nonce，服务器应保持时间同步。

旧版 Aster API Key / Secret 不能转换成 API Pro 私钥。升级后重新填写 API 钱包即可；旧估值、历史和 Bybit 连接会保留，Aster 验证失败不会替换原连接。若 Aster 返回账户未入金限制，请在 Aster 官方页面检查账户状态。

## OKX 账户资产

在“交易所连接”中选择 OKX，填写国际站实盘 API Key、Secret 和创建 API 时设置的 Passphrase。仅开启读取权限，服务会验证权限和资产读取成功后加密保存三项凭据；更新失败保留原连接。首次成功时新增一条 OKX 资产，已有同名手动行会复用，多条同名行需先合并。断开后保留最后估值、源时间和历史记录。

总额直接读取 OKX 账户资产估值接口的 USD 总额，明细展示接口返回的交易、资金、理财等账户折合金额；这些不是实际 USD 币种持仓。不再次累加保证金、浮盈亏或持仓名义金额，不自动遍历子账户，分项与总额可能有舍入差异。资产更新时间采用 OKX 返回的估值时间，缺失、过期或异常数据保留旧值。OKX 已有美元估值，因此其他币价源故障不影响它独立刷新。

连接和同步仍使用现有账本、日快照与 Hub 后台同步流程，无需数据库迁移。与工作台一起升级时执行：

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/install-all.sh | sudo bash -s -- --only asset,hub
```

## 出金调整与资产变化

总览同时展示原口径表内总额、实际持有资产、累计出金及剔除出金影响后的资产：

- 原表的“出金”行是已包含在总额内的累计出金。实际持有资产 = 表内总额 − 该行金额；空值按原表合计规则视为 0。
- 累计出金 = 原表“出金”金额 + 截至当日登记的新增出金。
- 剔除出金影响后的资产 = 实际持有资产 + 累计出金。入金暂不调整，变化金额不是投资收益。

在“出金记录”登记原表基准日起、尚未包含在原表里的新增提款，使用发生日（北京时间）和当时美元价值，可修改或删除。原表历史出金自动纳入，不要重复登记；同一笔也不要再加到原表“出金”行。交易所、钱包之间仍在账本范围内的转账不算出金。登记只调整统计，账户余额由同步或手动编辑反映，不会自动扣款或修改持仓。

曲线使用每日实际快照；同日优先取日快照，否则取最后一份原表记录。历史表仍保留全部原记录，未来预填及归档示例不参与曲线，缺失日期不补造估值。基准日的新提款只调整同日日快照及后续记录，不调整当天的原表基准记录。补录和修正会重新计算相应日期起的调整口径，不改写历史原始总额。出金记录随 SQLite 数据库保存，升级无需迁移，备份和恢复包含该记录。

## 本地开发与验证

Hub 使用与账本相同的登录会话读取 `GET /api/hub/summary?schemaVersion=2`。摘要只读取当前公开估值及历史总额字段，返回最多 90 个有效日期；同日优先日快照，排除未来预填与归档，时间按北京时间，曲线保持表内总额口径（包含原表出金行），不是投资收益。当前持有额单独扣除原表出金行，汇率单位为 CNY/USD。动态资产以最早源时间判断 15 分钟过期；只有全部明确标记手动的账本才视为静态，未知来源、示例、缺失估值和汇率异常仍会报告。

Hub 交易模块可一次性导入本账本保存的全球站 Binance、Bybit HMAC 及 OKX 连接，再向交易所重新验证只读权限。`GET /api/hub/trading-connections` 仅返回当前登录所有者的连接可用性、密钥尾号及版本；默认保留 Binance、Bybit 两条目录供旧版 Hub 使用，新版 Hub 通过 `?include=okx` 获取包含 OKX 的三条目录，两种响应均为 `schemaVersion: 1`，目录不包含密钥、Secret 或 Passphrase。`POST /api/hub/trading-connections/export` 要求有效会话、同源 JSON 请求、准确连接版本和再次验证 Asset 登录密码；密码尝试每所有者 15 分钟最多 5 次失败，响应禁止缓存。OKX 导出凭据包含 API Key、Secret 和 Passphrase；Aster、非全球站或损坏连接不会导出。Hub 后台使用已保存的 Asset 登录密码，通过 HTTPS 或本机回环 HTTP 请求；密钥不会经过 Hub 页面，代理页面也不能访问导出接口。导入后连接独立管理，源连接变更不自动同步到交易模块。两端升级可运行：`curl -fsSL https://raw.githubusercontent.com/hxx344/project-aggregation/main/install-all.sh | sudo bash -s -- --only asset,hub`。

在 Hub 的受信任代理 iframe 中，账本通过 `project-hub` v1 握手；仅接受同协议和端口的 `hub.localhost` 父窗口消息。未激活、隐藏或离线时暂停页面自动同步，恢复时立即刷新；Hub 自己的后台同步不受影响。保存、导入及实际同步更新会通知 Hub 重读摘要，纯读取不广播。Hub 导航只打开账本总览，不将交易钱包地址映射成资产账号。独立打开账本仍按可见页面每 60 秒同步。

同步和保存快照只读取当前状态，最终响应再读取历史；常规日快照按现有日期索引查询，归档仍按实际日期合并。Bybit、Binance 与 Aster 在行情就绪后并行同步，Aster 同时最多处理 3 个账号；单账号失败保留该账号旧值，所有任务结束后才释放 owner 锁。部署继续沿用按提交内容缓存的一键增量安装，无数据库迁移。

Node.js 24.15+：

```bash
npm ci
npm run dev
```

开发地址 `http://127.0.0.1:5173`，首次启动显示随机密码；配置和数据库在 `.data/`。安装依赖只在缺少导入文件时复制示例，不覆盖已有个人数据。

原表导入需 Python 和 `openpyxl`，在首次打开账本前执行：

```bash
python scripts/import-workbook.py "资产统计.xlsx" 2026-09-19
```

日期参数是统计起始日，可选第三个参数指定 JSON 输出路径。初始化后原始快照也保存在 SQLite，替换导入文件不覆盖已有账本。

如果已经打开过示例账本，生成文件后通过页面导入：

```bash
python scripts/import-workbook.py "资产统计.xlsx" 2026-09-19 "outputs/资产统计-导入.json"
```

```bash
npm test
npm run build
npm run test:smoke
```

测试覆盖估值、签名、只读路由、行情时效、登录、迁移、事务回滚、导入校验与自动备份、连接和修改保留、重复导入及重启保留数据。生产启动测试使用临时示例数据库，不访问真实交易所。`bash tests/install-incremental.sh` 使用临时 Git 仓库验证内容键、环境和统计标记，可在原生 Git Bash 执行。Linux 持续集成在隔离 runner 验证文档/测试更新不构建或重启、真实产物版本、API 与环境变更重建、缓存和独立依赖复用、端口配置更新及失败回滚；不应在生产服务器手动运行安装集成测试。

Schema 位于 `db/schema.ts`，`npm run db:generate` 生成增量迁移。迁移执行一次并校验文件哈希，请勿修改已执行的 SQL。

## 官方资料

- [Next.js 独立部署](https://nextjs.org/docs/app/guides/self-hosting)、[Node.js SQLite](https://nodejs.org/api/sqlite.html)
- [Bybit 钱包余额](https://bybit-exchange.github.io/docs/v5/account/wallet-balance)、[只读权限](https://bybit-exchange.github.io/docs/v5/user/apikey-info)、[资金账户](https://bybit-exchange.github.io/docs/v5/asset/balance/all-balance)
- [Binance API 权限](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account)、[钱包资产余额](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/asset)
- [OKX 请求签名与只读权限](https://www.okx.com/docs-v5/en/#overview-rest-authentication)、[账户配置](https://www.okx.com/docs-v5/en/#trading-account-rest-api-get-account-configuration)、[账户资产估值](https://www.okx.com/docs-v5/en/#funding-account-rest-api-get-account-asset-valuation)
- [Aster API Pro 签名](https://asterdex.github.io/aster-api-website/futures-v3/general-info/)、[合约账户](https://asterdex.github.io/aster-api-website/futures-v3/account%26trades/)、[现货账户](https://asterdex.github.io/aster-api-website/spot-v3/account%26trades/)
- [CoinGecko](https://docs.coingecko.com/reference/simple-price)、[Coinbase](https://docs.cdp.coinbase.com/coinbase-app/track-apis/exchange-rates)
- [Frankfurter 汇率与 ECB 来源筛选](https://frankfurter.dev/)

真实 Bybit / Binance / OKX / Aster 账户需在页面填写对应凭据后验证，测试使用临时生成的测试钱包和合成账户数据。

页面已打开时，资产自动同步在浏览器后台或平台其他模块中仍按 60 秒运行；恢复前台、网络连接或历史页面时会立即补查。嵌入平台时，后台同步仅由可信平台的 backgroundUpdates 许可启用，旧平台仍按原活动状态控制。离线、页面卸载、编辑或导入期间保留现有暂停及请求互斥。浏览器休眠期间无法保证固定节拍。
