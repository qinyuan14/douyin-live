# 实景直播经营系统 · 架构审查报告

> 审查时间：2026-08-21 00:18（Asia/Shanghai）
> 审查范围：工程骨架、核心业务机制、安全与合规边界、构筑方向
> 审查方式：源码逐层阅读（workspace 配置 → contracts → core → api → desktop → 测试）

---

## 结论速览

| 维度 | 判定 | 说明 |
|---|---|---|
| **工程骨架** | ✅ 健康 | 四层分包职责清晰、依赖单向无循环、构建/测试链完整 |
| **核心业务机制** | ✅ 稳健 | 证据保全/门禁/白名单/备份设计严密，多道兜底 |
| **安全与合规** | ⚠️ 2 项需补 | ① 激活仅 UI 层拦截（API 可绕过）；② 场次乐观锁未真正实现 |
| **构筑方向** | ✅ 正确 | 本地优先/风险兜底/可售卖三条主线与产品定位一致，无方向性错误 |

**总体判断：骨架没问题，构筑方向没问题。** 当前是"机制完备但未经真实业务验证"的健康状态，发现的 2 项问题均属"加固项"而非"方向错误"，不阻塞继续推进，但建议在正式售卖前修复。

---

## 一、工程骨架审查

### 1.1 分层结构（健康）

```
apps/desktop (Electron 双窗口 + React)
    │ 仅依赖 contracts
    ▼
apps/api     (NestJS 本地服务，端口 3188)
    │ 依赖 contracts + core
    ▼
packages/core (纯 TS 业务逻辑：数据库/门禁/证据/激活/备份/状态机)
    │ 仅依赖 contracts
    ▼
packages/contracts (类型 + Zod schema，唯一依赖 zod)
```

- **依赖方向正确**：contracts ← core ← api ← desktop，单向无循环。desktop 不直接依赖 core（所有业务经由 API），符合"渲染层零业务逻辑"的隔离原则。
- **contracts 只导出类型 + schema**（图标/装饰器由消费方直供）——这是从历史事故（空目录）沉淀的正确教训，目前无再犯。
- **单进程 JSON 存储**：`LiveDatabase` 全内存 + 8 个 JSON 全量落盘。对"单店单机单直播间"的定位完全够用；数据量上限清晰（订单数百条级），无过度设计。**这不是问题，是匹配定位的选择。**

### 1.2 构建/测试链（健康）

- `pnpm check`（lint → typecheck → test → build）全绿；21 项测试（API 16 + Desktop 3 + core activation 2）。
- 测试覆盖关键安全语义：run-sheet 禁止表达、证据保全校验、并发单例、备份篡改拒绝、恢复防直播中、激活篡改拒绝——**覆盖的是"安全兜底"而非"业务功能"**，与产品风险优先的定位一致。
- 打包链路（package-win.mjs）有中文路径/占用/hoisted 等坑的修复记录，可重复打包。

### 1.3 骨架层面唯一提醒（非问题）

- `core` 的 `test` 脚本仍是 `echo` 占位（activation.test.ts 需手动跑 dist），未纳入 `pnpm test` 统一入口。建议把 activation 测试接入 core 的 test 脚本，避免新人漏跑。

---

## 二、核心业务机制审查

### 2.1 证据保全链（设计严密 ✅）

```
上传（MIME/扩展名/大小/隐私脱敏校验）→ SHA256 保全 → evidence.json 登记
→ EvidenceRef 引用 → 任何展示/播报前 evidenceMatchesStoredFile（文件存在+指纹一致+未过期）
```

- 文本证据自动拦截完整隐私（姓名/电话/身份证/地址/订单号/微信QQ支付宝邮箱）；图片/PDF 要求人工确认。
- 白名单知识（APPROVED_LIVE_KNOWLEDGE.md）SHA256 钉死，任何改写 → 播报阻断。
- 备份恢复跨目录会重写证据绝对路径并重新核对指纹——**这是最容易出错的环节，实现正确**。

### 2.2 开播硬门禁（机制完备 ✅）

- 6 项门禁：3 项需证据（official-written/cost/asset）、1 项需设置确认（service-area）、2 项需人工确认（hardware/authorization）。
- 服务区门禁已从"非空即过"加强为"向导显式确认"（任务E 修复），占位数据不再能骗过。
- `formalTrialUnlocked` 恒为 false + 当次授权恒 MANUAL_REQUIRED → **当前版本物理上无法真实开播**，符合"本地商用候选"定位。

### 2.3 状态机与安全心跳（基本正确 ✅）

- 状态流转表合法（DRAFT→READY→LIVE→…），非法流转拒绝。
- 30s 心跳覆盖：两小时上限、设备失效、商品证据失效、员工失联（连续 2 次未确认自动 PAUSED）——多道 fail-closed 兜底。

### 2.4 离线授权（设计正确 ✅）

- Ed25519 签名授权码绑机器码；activation.json 独立于备份（跨机恢复不带激活，无法借备份绕过）；篡改/过期/换机全拒绝。
- **注意**：machineId 依赖 CPU 型号 + MAC + 主机名 + 内存——重装系统/换网卡/换内存可能导致机器码变化需重新激活。这是绑机器的固有代价，售卖时需在买家须知里说明（硬件变更需联系卖家重新生成）。

---

## 三、安全与合规边界审查（2 项需补）

### ⚠️ 发现 1（中危）：激活仅 UI 层拦截，API 层可绕过

- **现状**：未激活时，ControlApp 显示激活门禁、OutputApp 显示遮罩——但**所有 API 端点（含 bootstrap/offers/sessions 等业务接口）都不校验激活状态**。
- **风险**：懂技术的用户可自行读 `runtime-token` 文件（本地文件，权限 0600 但本机用户可读）→ 直接 curl API → **绕过付费激活使用全部功能**。这与"可售卖"目标直接冲突。
- **建议**（售卖前必做）：在 `runtime-auth.ts` 的本地访问守卫中增加激活校验（除 `/activation`、`/health` 外的端点，未激活一律 403），或在 `LiveService` 加统一守卫。工作量约 30 分钟。

### ⚠️ 发现 2（低危）：场次乐观锁未真正实现

- **现状**：`saveSessionIfCurrent(session, _prevState, _prevUpdatedAt, ...)` 的 `_prevState`/`_prevUpdatedAt` 参数带下划线前缀**未使用**——方法名是"IfCurrent"但实际不比对当前状态，直接覆盖写入。
- **风险**：心跳（30s）与员工手动操作并发时，理论上存在"后写覆盖先写"竞态（如心跳检测到设备失效正要 PAUSED，员工同时 STOPPED，最终可能停在 PAUSED 而不是 STOPPED）。JS 单线程 + await 使窗口极小，测试也未暴露，但状态机语义上不严谨。
- **建议**：在 saveSessionIfCurrent 内加 `if (existing.state !== prevState || existing.updatedAt !== prevUpdatedAt) throw` 的乐观锁检查（约 10 行），或明确注释"单线程下由服务层串行保证"并加文档说明。

### 其他安全项（均通过 ✅）

- 端口仅监听 127.0.0.1；CORS 白名单；runtime-token 每次启动重生成、0600。
- Electron 窗口 sandbox + contextIsolation + nodeIntegration off；token 经 argv → preload → contextBridge 注入，页面脚本无法窃取。
- CSP 严格（default-src 'self'，仅连本机 API）。
- 上传校验（MIME/扩展名/大小/隐私）完整；备份名防路径穿越（isSafeBackupName）。

---

## 四、构筑方向审查

### 4.1 三条主线与定位一致 ✅

| 构筑主线 | 落地情况 | 判定 |
|---|---|---|
| **本地优先**（不登录/不抓取/不模拟点击） | 无任何平台自动化代码，全本地 | ✅ |
| **风险兜底**（证据保全/门禁/心跳/人工接管） | 层层 fail-closed，是本项目最强资产 | ✅ |
| **可售卖**（去品牌化 + 离线授权） | 任务E 已完成，机制就绪 | ✅（见发现 1 加固项） |

### 4.2 方向性观察（非问题，供决策参考）

1. **通用化与行业深度的平衡**：任务E 已把行业绑定去掉（服务区/类目/话术模板化）。当前是"通用合规骨架 + 商家自填行业信息"。若后续想深耕某一行业（如洗护），可考虑"通用骨架 + 行业包"双轨，但**现阶段保持通用是正确的**（先卖通用，再按需定制）。
2. **业务闭环的验证依赖真实数据**：cohort 报告的 `qualifies` 恒为 false（设计如此，防止程序自证赚钱）——这是优点（防虚假宣称），但意味着**商业验证必须靠真实订单跑 30 晚**，无法加速。这是定位决定的，不是缺陷。
3. **单实例假设**：所有设计假设"单店单机单直播间"。若未来多店/多直播间，需引入数据库与并发改造——当前不需要，但**文档应明确这个边界**，避免被误用。
4. **API 无版本前缀**：端点直接 `/offers` 等，无 `/v1`。本地单机可接受，但既然是付费软件，未来升级若改契约，加版本前缀成本低，可提前规划（不急）。

---

## 五、建议优先级

| 优先级 | 事项 | 原因 |
|---|---|---|
| **P0（售卖前必做）** | 激活校验下沉到 API 层（发现 1） | 否则付费机制可被绕过，直接损失收入 |
| **P1（近期）** | 场次乐观锁补上（发现 2） | 状态机语义严谨性，防极端并发 |
| **P2（顺手）** | core 的 activation 测试接入 `pnpm test` | 防新人漏跑 |
| **P3（规划）** | 文档写明"单店单机单直播间"边界；API 版本前缀 | 防误用，为升级留余地 |

---

## 附：审查依据文件清单

- 根 `package.json` / `pnpm-workspace.yaml`（workspace 骨架）
- `packages/contracts/src/contracts.ts`（契约）
- `packages/core/src/`（database / preflight / transition / evidence / activation / backup / evaluation / cohort）
- `apps/api/src/`（service / controller / runtime-auth / run-sheet）
- `apps/desktop/src/`（main/main.ts / preload.cts / api.ts / ControlApp / OutputApp / Onboarding / ActivationGate / broadcast.ts）
- 测试：`apps/api/src/*.test.ts`、`apps/desktop/src/lib/*.test.ts`、`packages/core/src/activation.test.ts`（21 项全绿）
