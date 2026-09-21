# 资产统计

个人资产面板，支持 Excel 历史导入、Virtual 实时报价、Bybit / Aster 只读同步和手动估值。使用 Next.js、Node.js 24 和 SQLite，无需 Sites、Cloudflare 或外部数据库账号。公开仓库仅含虚构示例数据，不含真实资产记录和凭据。

## 一键部署

支持 Ubuntu 22.04 / 24.04、Debian 12 / 13，amd64 / arm64，需 systemd。建议至少 2 核、4 GB 内存和 3 GB 可用磁盘，供服务器构建使用。

```bash
curl -fsSL https://raw.githubusercontent.com/hxx344/asset-ledger/main/install.sh | sudo bash
```

自动安装依赖和 Node.js、校验下载、拉取代码、构建、生成登录密码、初始化 SQLite 并注册开机自启服务。首次安装仅监听服务器本机 `127.0.0.1:5678`，通过 SSH 隧道访问，使用终端显示的独立登录密码进入账本。服务器只需允许现有 SSH 连接，无需对公网开放 5678；脚本不修改 SSH 服务或防火墙规则。

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

**升级再次执行同一条命令。** 未指定端口和 `--local` 时保留原端口及监听地址，所以旧版公网监听需要显式加 `--local` 切换；保留密码、加密密钥、资产和历史。先构建新版本，再停止旧服务并备份数据库；启动检查失败时恢复旧版本、端口和数据库。备份保留在 `/opt/asset-ledger/backups/`，不会自动删除。

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
sudo -u asset-ledger env ASSET_DATA_DIR=/var/lib/asset-ledger /opt/asset-ledger/runtime/node-v24.15.0-linux-$( [ "$(uname -m)" = x86_64 ] && echo x64 || echo arm64 )/bin/node /opt/asset-ledger/current/scripts/configure.mjs --reset-password
```

若曾通过 systemd override 设置过 `PUBLIC_ORIGIN`，切换 SSH 隧道时应移除该设置并重启服务，恢复按本机访问地址校验来源。升级会保留已有 override。

## 数据口径

- Virtual：优先使用 CoinGecko 美元报价，失败时改用 Coinbase 美元兑换率倒数；分别标明行情时间或获取时间。数量手动维护。
- Bybit：只读 HMAC API，验证 `readOnly = 1` 后读取统一账户 `totalEquity` 和资金账户余额。包含未实现盈亏，不重复累加保证金或持仓名义价值；不含子账户及 Earn。
- Aster：API Pro 钱包地址（signer）+ 对应私钥，使用 V3 EIP-712 签名。读取 `/fapi/v3/accountWithJoinMargin` 的合约 `marginBalance`，可选 `/api/v3/account` 的现货 `free + locked`。不含质押；程序只允许这两个余额查询 GET 路由，不开放交易、划转或提现功能。
- USD/CNY：随资产刷新自动获取 Coinbase 当前汇率（直接使用每美元对应人民币数量）；失败时使用 Frankfurter 的 ECB 日度参考汇率。页面标明来源及获取时间 / 报价日期，不把日度参考标成逐笔实时报价。两者均失败则保留旧值及原时间，并提示失败；汇率失败不阻止交易所同步。临时手动备用值会在下次自动获取成功后被替换，历史快照保留当时汇率。
- 其他资产保留原值，支持手动编辑；不把项目名误当作同名代币，积分和 NFT 保留预估口径。
- 页面打开且前台在线时每 60 秒刷新，每天保存最近一次刷新或编辑。页面关闭时没有后台定时任务。
- 接口失败保留旧值及原时间，不用零覆盖失败结果。资产变化含资金进出，不能视为投资收益。未来预填记录不参与历史曲线。

Bybit API Secret 和 Aster API 钱包私钥使用 AES-GCM 加密，登录密码采用加盐 scrypt。会话 Cookie 为 HttpOnly，接口验证登录和写入来源。数据库、配置、Excel 和导入数据均被 Git 忽略。备份或迁移应同时保留数据库及 `config.json`，否则无法解密旧连接。

## Aster API Pro 连接

在「交易所连接 → 新增 Aster 账号」填写账号名称、API Pro 页面生成的 **API 钱包地址**和**对应私钥**，可选择同时同步现货。不需要主钱包私钥。服务端先校验地址与私钥匹配，再读取账户；验证成功后加密保存。私钥不返回浏览器、不写入日志，也不作为请求参数发送给交易所。

最多支持 10 个 Aster 账号，各自保存余额、同步时间和错误；资产明细中的 Aster 为所有账号净权益之和，展开可按账号核对。升级自动保留原连接为“默认账号”，不需要重填；首次连接替换原表估值。某个账号失败只保留该账号旧值，其余继续更新，汇总时间取最旧账号时间。

“更新连接”可修改名称、凭据和现货范围；“断开并保留估值”删除私钥并保留余额；“移除账号”删除连接并从当前汇总扣除其余额，过去日期的快照不变。移除最后一个账号后 Aster 当前估值为零。相同 API 钱包不能重复添加；不同 API 钱包可能指向同一实际账户，系统不能识别这种重复，请每个实际账户只添加一次，更换钱包使用“更新连接”。新增或移除账号不是出入金，系统不会自动生成出金记录。

签名采用官方 V3 的 `AsterSignTransaction` 域、`chainId = 1666`、`Message(string msg)`；签名内容为实际发送的 URL 编码查询串，包含唯一微秒 `nonce` 和 `signer`。合约与现货使用不同 nonce，服务器应保持时间同步。

旧版 Aster API Key / Secret 不能转换成 API Pro 私钥。升级后重新填写 API 钱包即可；旧估值、历史和 Bybit 连接会保留，Aster 验证失败不会替换原连接。若 Aster 返回账户未入金限制，请在 Aster 官方页面检查账户状态。

## 出金调整与资产变化

总览同时展示原口径表内总额、实际持有资产、累计出金及剔除出金影响后的资产：

- 原表的“出金”行是已包含在总额内的累计出金。实际持有资产 = 表内总额 − 该行金额；空值按原表合计规则视为 0。
- 累计出金 = 原表“出金”金额 + 截至当日登记的新增出金。
- 剔除出金影响后的资产 = 实际持有资产 + 累计出金。入金暂不调整，变化金额不是投资收益。

在“出金记录”登记原表基准日起、尚未包含在原表里的新增提款，使用发生日（北京时间）和当时美元价值，可修改或删除。原表历史出金自动纳入，不要重复登记；同一笔也不要再加到原表“出金”行。交易所、钱包之间仍在账本范围内的转账不算出金。登记只调整统计，账户余额由同步或手动编辑反映，不会自动扣款或修改持仓。

曲线使用每日实际快照；同日优先取日快照，否则取最后一份原表记录。历史表仍保留全部原记录，未来预填及归档示例不参与曲线，缺失日期不补造估值。基准日的新提款只调整同日日快照及后续记录，不调整当天的原表基准记录。补录和修正会重新计算相应日期起的调整口径，不改写历史原始总额。出金记录随 SQLite 数据库保存，升级无需迁移，备份和恢复包含该记录。

## 本地开发与验证

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

测试覆盖估值、签名、只读路由、行情时效、登录、迁移、事务回滚、导入校验与自动备份、连接和修改保留、重复导入及重启保留数据。生产启动测试使用临时示例数据库，不访问真实交易所。Linux 持续集成还会验证首次安装仅监听本机、升级切换为本机监听和失败回滚。

Schema 位于 `db/schema.ts`，`npm run db:generate` 生成增量迁移。迁移执行一次并校验文件哈希，请勿修改已执行的 SQL。

## 官方资料

- [Next.js 独立部署](https://nextjs.org/docs/app/guides/self-hosting)、[Node.js SQLite](https://nodejs.org/api/sqlite.html)
- [Bybit 钱包余额](https://bybit-exchange.github.io/docs/v5/account/wallet-balance)、[只读权限](https://bybit-exchange.github.io/docs/v5/user/apikey-info)、[资金账户](https://bybit-exchange.github.io/docs/v5/asset/balance/all-balance)
- [Aster API Pro 签名](https://asterdex.github.io/aster-api-website/futures-v3/general-info/)、[合约账户](https://asterdex.github.io/aster-api-website/futures-v3/account%26trades/)、[现货账户](https://asterdex.github.io/aster-api-website/spot-v3/account%26trades/)
- [CoinGecko](https://docs.coingecko.com/reference/simple-price)、[Coinbase](https://docs.cdp.coinbase.com/coinbase-app/track-apis/exchange-rates)
- [Frankfurter 汇率与 ECB 来源筛选](https://frankfurter.dev/)

真实 Bybit / Aster 账户需在页面填写对应凭据后验证，测试使用临时生成的测试钱包和合成账户数据。
