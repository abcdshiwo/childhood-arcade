# 街机库扩容、缩略图与玩家工具栏设计

## 目标

把当前的七款演示游戏扩展成一个适合朋友进入小房间游玩的网页街机厅，并完成三件彼此衔接的工作：

1. 玩家页面固定显示可直接点击的“投币”和“开始”按钮，同时继续支持用户自定义键盘与手柄。
2. 公共游戏库采用已选定的“CRT 霓虹街机厅”视觉方向，并给每个实际 ROM 匹配真实游戏截图。
3. 从用户提供的 `W165_709.7z` 中批量提取、校验、传输和导入所有真实游戏 ROM，保留可复查清单和完整回滚点。

本次仍沿用 Nostalgist + RetroArch Emscripten + FBNeo 的房主串流架构，不迁移到 EmulatorJS，也不把这次工作扩展成竞技级 rollback 联机改造。

## 已确认的源数据边界

`W165_709.7z` 实际是带密码的 RAR5 文件，大小为 5,110,938,526 字节。包内“600 多个”来自配置、作弊文件、截图和模拟器内置目录，并不等于 600 多个实际 ROM 文件。

| 内容 | 已核验数量 | 处理方式 |
| --- | ---: | --- |
| CPS1 ROM ZIP | 35 | 进入兼容性校验 |
| CPS2 ROM ZIP | 41 | 进入兼容性校验；缺 key 的集合不得直接发布 |
| Neo Geo 目录 ZIP | 166 | 其中一个是 `neogeo.zip` BIOS |
| 实际游戏源 ZIP | 241 | 全部进入导入批次，并作为全局 ROM 字节池重建原版与改版 |
| ZIP 完整性 | 242 / 242 | 含 BIOS 的内层 ZIP 均通过 7-Zip 完整解压测试 |
| 游戏截图短名 | 493 | 241 个游戏候选全部有同名截图 |
| ROM 与截图精确匹配 | 241 / 241 | 转为 WebP 后用于图库 |
| 只有截图、没有 ROM 的短名 | 252 | 仅记录在报告中，不伪造成可玩游戏 |
| 标题覆盖 | 241 / 241 | 使用已锁定的线上 FBNeo 精确 DAT；旧短名仍需按成员 CRC 唯一映射 |

ROM、INI 和截图的联合目录实际只有 597 个短名，其中包含 BIOS；cheats 目录单独有 601 个 DAT，这正是“600 多个”最容易产生的来源。辅助短名本身不能证明有可玩的 ROM，但如果它对应 exact DAT 中的 clone、hack 或 bootleg，并且所需的全部 ROM 字节都能从 241 个源 ZIP 的全局池中唯一重建，就可以成为独立游戏条目。

因此本次交付目标是：完整保留 241 个真实源 ZIP，并从中重建尽可能多的原版、clone、HACK 与 bootleg 游戏。最终游戏条目数不再被物理 ZIP 数限制，而以“exact core contract 可唯一重建，并通过该 build 锁定的 core artifact、BIOS 和浏览器运行时验证”为准。未通过的文件保留在服务器隔离区和批次报告中，不丢弃，也不显示成可以启动的游戏。

线上核心已经完成可复现的来源绑定：`fbneo.js` SHA-256 为 `CD8E329CAA68E7125B1F70FF91129F97B2935745F5FBAA31BA4E3AB1BCCD4697`，`fbneo.wasm` SHA-256 为 `7AD627B58DE8832DBCEB9C9B92C18E5EE198B87EB3ADA95F4AC1AAA80755EF23`，运行时报告 FBNeo `v1.0.0.03 2f41022`。导入批次固定使用提交 `2f41022002337ed20186144bbddb2d53392fab85` 的 Arcade DAT；该 DAT SHA-256 为 `E7B55931F73F458737D85AFF0BE1C516083AC8E0EE7ECD76068C864A8ACBA1C5`。核心 JS、WASM 和 DAT 三个哈希必须同时写入 manifest，任一变化都要求重新审计。

项目内现有 `mame2003_plus` 也已完成来源绑定：WASM SHA-256 为 `47A47E9555426A04C023303434B432B8C6A70D8AB6A420FE7446E6D6E8C2546C`，内嵌 Git 短提交对应 `libretro/mame2003-plus-libretro@62c7089644966f6ac5fc79fe03592603579a409d`；同提交 exact DAT SHA-256 为 `E935B1343B39A85FD9E67914F7EDFAB28F55F4502751D33288397AABD33D6DE9`。用同一个全局字节池静态审计后，MAME 可在 FBNeo 277 个候选之外额外重建 97 个互不重名的 CPS1 driver：29 parent、62 clone、6 bootleg，覆盖 32/35 个物理 CPS1 源包。

同一 RetroArch v1.22.2 构建中的 FBA2012 三个旧核心也已完成静态来源锁定。CPS1 专用核心 JS/WASM SHA-256 为 `1B6FCFECAE9A029DC0AD6706AF4E1163DA6CFDED3D92EC2E193FC711603FF590` / `021A05264877A9A1EA8C7722314513C2A1F23AB9491A2369B183B9788C524678`，对应源码提交 `2499e30247da4d2535c2df886186e165cbff48e7`；CPS2 专用核心为 `28F5E5E47BB609AABA7EA1CD99270D8B8854C4E3DFD9A4213A083964E05E2627` / `67A5FF138215511CF9AB3AF872D6499CF4B5A8BB1BAE530CBCEEBD33C050F4E1`，对应 `d618e992f33bc79d040f01e3b1589a05566725d9`；全量核心为 `EBA6A6074EB6C86D3AC640A3EE716461DA188FB35E32DE5C3B76EE18D032B80A` / `A19485F4060A3473C0229BD2BD4B68D5E13C1ECAE65BB91728F7EAEC3337AFDB`，二进制内嵌提交 `77167cea72e808384c136c8c163a6b4975ce7a84`。专用核心运行时为 `v0.2.97.28`，全量核心为 `v0.2.97.29 77167ce`；专用核心源码锁定依赖二进制字符串与构建时间边界，证据强度低于全量核心的内嵌提交，因此也必须写入 artifact provenance。

FBA2012 没有另行宣称上游发布的 DAT，本批次使用从对应源码 driver/ROM 表确定性生成的 runtime contract：CPS1 `1C4308E91A967F9306E744DC906ABAFAF5101B4082EB9FB80FFDD20A21CE95AA`、CPS2 `4D0D953871E18275862258562EAA6F55D9B633967669673787C13407A41B2636`、全量 `FB8D82FB3A222B1C5836AF0A8CDA09F9192DFA7CEBE8448B4C5DC087E3E8FF93`。按 FBNeo → MAME → FBA 优先级，FBA 对前两者新增 304 个 shortname；折叠 22 个与 MAME 基线完整 size+CRC 合同相同的别名后保留 282 个 FBA driver 行、281 个不同字节合同。当前静态候选因此为 656 个 driver 行、655 个不同字节合同；按各核心标志归一化为 227 parent、361 clone、4 hack、64 bootleg，而不是由 601 个 cheat 文件推断出的数量。任何一项在运行期验证前都仍只是候选。

## 方案选择

### 方案 A：原样导入所有 ZIP

优点是最快，缺点是 WinKawaks 包中的部分 ZIP 混装了 parent、clone 或 hack 成员，CPS2 还可能缺少当前 FBNeo 所需的 key。直接公开会产生大量“文件存在但游戏打不开”的条目。

### 方案 B：批次清单、规范化校验、合格后发布（采用）

先把 241 个源 ZIP 和全部截图完整放入批次暂存区，再用与线上一致的核心/DAT 把所有 ZIP 成员汇成按名称、大小和 CRC 索引的全局字节池，生成可重建的原版、clone、hack 与 bootleg 条目。所有源文件和派生条目都有记录，但只有 `ready` 条目进入公共图库。

该方案多一道校验，但它能保证幂等重跑、明确失败原因、不中断现有七款游戏，并为以后追加新包提供同一条导入路径。

### 方案 C：只导入截图和目录，ROM 按需上传

传输量最小，但会出现大量无法点击游玩的空卡片，不符合“把实际游戏传上去”的目标，因此不采用。

## 工作分解

这次发布拆成三个边界清晰、可分别验证的子系统：

1. **玩家控制层**：工具栏按钮、150ms 按键保持、房主/P1 与访客/P2 路由、真实核心输入冒烟测试。
2. **游戏库展示层**：缩略图字段和接口、图库卡片、CRT 霓虹主题、懒加载和回退图。
3. **可信导入层**：解包、标题/截图匹配、哈希、兼容性状态、备份、幂等数据库写入、隔离与回滚。

三个子系统通过稳定接口连接：玩家只消费 ROM API；图库只消费序列化后的 `thumbnailUrl` 和兼容状态；导入器是唯一可以绕过普通 HTTP 上传大小限制的可信入口。

## 玩家工具栏与输入设计

### 已验证事实

线上 FBNeo 的实际配置为 `input_player1_select = "num1"`、`input_player1_start = "enter"`。真实页面中把 `Digit1` 保持 150ms 后，画面从 `CREDIT 00` 变为 `CREDIT 01`；再把 Enter 保持 150ms，游戏成功进入开始流程。

零延迟自动化按键会让 `keydown` 和 `keyup` 在 RetroArch 同一次轮询中被处理，核心看不到“按下的一帧”。因此不修改现有 `num1` 映射，也不改成 `keypad1`。

### 按钮行为

- 工具栏从游戏元数据开始加载时就渲染，位于返回按钮之后、居中标题之前；下载核心、等待房主、启动失败和重连状态都不能卸载它。街机显示 `投币` 和 `开始`，非街机平台改用 `选择` / `开始` 或隐藏不适用按钮；窄屏仍保留图标和中文短标签。
- 单机和房主模式使用该次 boot 时冻结的 P1 `select` / `start` 映射；运行中修改按键继续按现有规则在重新进入或重启核心后生效。按钮复用已经验证过的全局事件 dispatcher，向 `window` 与 `document` 发出对应 DOM `keydown`，保持 150ms 后再发 `keyup`，不能只向 canvas 派发。
- 房间访客点击按钮时，不在本地派发键盘事件，也不分别发送可能丢失的 `down` / `up`。WebRTC 新增独立的 reliable/ordered `controls` DataChannel；访客发送 `control-pulse`，ID 固定为 `peerSessionEpoch + sequence`。房主按房间 boot 时冻结的 P2 映射在本地完成 `keydown → 150ms → keyup`，对重复 ID 只回 ACK 不重复执行；访客在 ACK 超时后只重试同一 ID，重连会生成新 epoch，不能与旧序号碰撞。实时方向/动作输入仍可留在现有低延迟通道，两类消息不混用。
- 核心尚未 boot、访客 DataChannel 未 open、角色正在切换或房间正在关闭时，按钮保持可见但禁用并说明原因。按钮执行期间防重复触发；路由切换、换 ROM、房间关闭、DataChannel 断开、角色变化和组件卸载都必须清除计时器并释放尚未松开的按键。
- 全屏目标改为包含工具栏和模拟器的整个 player 容器，而不是仅模拟器 wrapper，因此进入全屏后工具栏仍可见。
- 不调用 Nostalgist 高层 `press('select')`，因为当前版本的数字键辅助转换存在 `num1` / `keypad1` 方向疑点。
- 自定义按键面板继续保留；默认街机布局仍是 WASD、J/K/U/I、数字 1 投币、Enter 开始。

## CRT 霓虹街机厅界面

### 视觉语言

- 深黑蓝背景叠加轻微扫描线、噪点和暗角，不使用大面积白底或通用紫色渐变卡片。
- 主强调色为电青，次强调色为品红，操作性强的“投币/开始”使用琥珀或街机按钮红，成功/在线状态保持绿色 LED。
- 游戏截图保持原始 4:3 比例，采用像素化放大和 CRT 玻璃边框；标题和状态信息位于独立的信息底座，避免覆盖画面主体。
- 页面首次加载使用一次克制的卡片依次点亮动画；支持 `prefers-reduced-motion` 时关闭扫描和位移动画。
- 键盘焦点必须清晰可见，移动端按钮至少 44px，文本对比度不依赖霓虹发光。

### 图库卡片

每个可玩 variant 都是独立卡片，不再要求先点击 parent 再弹版本选择器。卡片显示：截图、游戏标题、平台/核心徽章、ROM set 短名、官方/非官方与 clone/HACK/bootleg 徽章、版本标签、收藏状态和可玩状态；搜索覆盖标题、set、版本、核心和关系类型。图片使用 `loading="lazy"` 和固定 4:3 容器，避免大量图片同时解码导致布局抖动。

若某个未来导入条目没有截图，显示由 CSS 绘制的街机屏幕占位图，并明确标注 set 名，不从网络随机抓取不确定的封面。

## 数据模型与 API

新增 `import_batches` 表记录批次 ID、所有者、cold source/manifest 哈希、计划与实际数量、总字节和状态，以及创建、发布、回滚时间。一个批次可以使用多个核心，因此批次表不再保存单一 core/DAT 哈希。状态完整覆盖 `staged`、`validating`、`committed_private`、`publishing`、`published`、`rolling_back`、`rolled_back`、`rollback_failed` 和 `failed`；每次状态迁移写入操作日志，进程中断后可以判断继续还是回滚。

新增不可变 `core_artifacts` 表，记录 `coreName`、显示版本、源码提交、JS/WASM/DAT 内容寻址资产 ID 与 SHA-256、BIOS manifest/资产引用和启停状态。核心、DAT 与 BIOS 文件都存入 shared 内容寻址目录，不能随旧 release 清理。FBNeo、MAME2003-Plus 与 FBA2012 都必须先登记为一个确切 artifact，播放器和导入器不能再用 `platform.cores[0]` 猜核心。

`roms` 保留为逻辑游戏/卡片，现有七条记录不改变 ID；新增：

- `setNameNormalized`：小写 canonical shortname，并由 SQLite `COLLATE NOCASE`/CHECK 约束而非只靠导入器保证大小写唯一。
- `variantKind`：`official`、`hack` 或 `bootleg`；官方 clone 使用 `official`，不把“是否 clone”和“是否非官方”压成同一枚举。
- `datParentSetName`：exact DAT 的直接 parent，仅表示谱系。
- `familyRootSetName`：图库分组根 set，仅用于搜索/筛选。
- `versionLabel`：地区、修订版或改版名称。
- `activeBuildId`：该逻辑 ROM 当前选中的不可变构建，允许为空；private manual ROM 可以指向 `unverified` build，公共目录只接受计算状态为 `ready` 的 active build。
- `activeThumbnailRefId`：当前生效的缩略图引用，允许为空。

公共目录所有者下使用 `(userId, platform, setNameNormalized)` 唯一约束，软删除行也参与唯一性。每个 variant 的 shortname 是独立 `roms` 行；同一逻辑 ROM 的核心升级或重新规范化不会创建第二张卡片，而是生成新的 build。

新增不可变 `rom_builds` 表：`romId`、`coreArtifactId`、`archiveAssetId`、`archiveSha256`、`contentManifestSha256`、`buildFingerprint`、`staticStatus=complete|blocked|unsupported`、`staticFailureCode`、`staticFailureDetailsJson`、`archiveLayout`、`runtimeParentBuildId` 和创建时间。规范化文件名固定为 `<setNameNormalized>.zip`；blocked 候选允许 `archiveAssetId` 为空。`split` 只能引用同 core artifact、同 DAT 世代且状态可用的直接 parent build，并以 `ON DELETE RESTRICT` 防止父构建被清理；`standalone` 即使存在 `datParentSetName` 也绝不挂载 parent。

`buildFingerprint` 为 canonical JSON 的 SHA-256，至少覆盖 set、core artifact fingerprint、child archive/content manifest SHA、`archiveLayout`、runtime parent build fingerprint/null 和 BIOS manifest SHA，并建立数据库唯一约束。构建记录不原地改写，发布只原子切换 `roms.activeBuildId`，旧 build 在仍被房间、存档或回滚点引用时不得删除。

运行结果从 build 身份中拆出为 append-only `build_validation_runs`：`romBuildId`、Headless Shell/浏览器哈希、harness 版本、核心/BIOS指纹、`result=passed|failed|inconclusive`、失败码、日志/帧证据资产、时间，以及 `acceptance=pending|accepted|rejected`、`acceptedAt`、`acceptedBy`、`policyVersion`。`inconclusive` 不能被 accepted；每个 build 最多一条 accepted run，接受新 run 时在同一事务中把旧 run 标为 rejected。相同 build 可以先超时、后复验通过而不复制 build。

计算状态唯一映射为：静态 `unsupported` → `unsupported`；静态 `blocked` → `blocked`；静态 `complete` 且没有 accepted run（包括没有运行或只有 inconclusive）→ `unverified`；accepted `passed` → `ready`；accepted `failed` → `blocked`。超时只追加 `inconclusive` run，不修改 immutable build。公共发布资格只接受 `ready`。

新增 `batch_build_refs` 与 `build_source_members`，记录同一 build 被哪些批次复用、由 cold source 的哪些成员/CRC/SHA 构成。`rom_builds` 不再用单一 `importBatchId` 表示唯一来源；回滚某批次时，仍被其他批次引用的 build 不能删除。

active 指针必须在数据库层保证同一 ROM 归属，而不只做普通单列 FK：`rom_builds` 对 `(id, romId)` 唯一，`rom_asset_refs` 对 `(id, romId)` 唯一；`roms` 分别用 `(activeBuildId, id) → (rom_builds.id, rom_builds.romId)` 和 `(activeThumbnailRefId, id) → (rom_asset_refs.id, rom_asset_refs.romId)` 复合外键。任何把 A 游戏的 build/缩略图指给 B 游戏的事务都必须被 SQLite 拒绝。

现有 `parentRomId` 迁移后只作为旧数据过渡来源，播放器不再根据它自动挂载父 ZIP；所有运行依赖只读取 `rom_builds.runtimeParentBuildId` 与 `archiveLayout`。

`rooms` 在创建时把服务器重新验证过的 `ready` active build 固定到 `romBuildId`；新逻辑只持久化 build 并由 `rom_builds.romId` 推导逻辑 ROM，不能只相信前端传入的 ROM ID。旧 `rooms.romId` 迁移期若暂时保留，必须用同一复合归属约束验证。房间生命周期中即使图库切换 active build，已开的房间仍使用原 build。房间内禁止直接切换版本；房主若选择另一个 variant，必须关闭/重建房间并向成员广播。创建房间和房间列表显示并搜索 set、版本、核心与 variant 类型。

save-state 元数据和服务端文件路径增加 `romBuildId`、core artifact/content fingerprint；浏览器 localStorage/IndexedDB key 也改为 `state:<buildId>:<coreArtifactFingerprint>`，不能继续使用同核心下会串档的 `state:${core}:${romId}`。现有七款云端和本地旧 key 只迁移/关联到对应 legacy build，不对新 build 自动复用；无法可靠归属的旧本地 key 保持隔离并提供一次性手动导入提示。批次回滚和 build 退休永远不删除用户存档。

缩略图使用内容寻址的 `assets` 表保存 `kind`、`filePath`、`mimeType`、`fileSize`、`sha256`，并用不可变 `rom_asset_refs` 关联 `romId`、`assetId`、`matchKind=exact|alias|parent|source_reference|placeholder`、`sourceSetName`、`sourceFileSha256` 和来源批次。`roms.activeThumbnailRefId` 决定当前接口返回哪条引用；切换 active ref 写入 `import_operations`。这样七组相同像素只保存一份文件，多张卡片各有独立引用；回滚或删除引用时只有 refcount 为零才清理底层文件。`source_reference` 必须在卡片上标为“参考图”，不能计入 exact 覆盖率。

公共 ROM 查询返回 `status=normal`、`isPublic=true` 且 active build 的计算后 `compatStatus=ready` 的所有独立 variant。序列化结果新增：

- `setName`、`variantKind`、`datParentSetName`、`familyRootSetName`、`versionLabel`
- `buildId`、`coreName`、`coreVersion`、`compatStatus`、`archiveLayout`
- `thumbnailUrl`、`thumbnailMatchKind` 和 `thumbnailSourceSetName`
- `thumbnailUrl` 查询参数包含完整 64 字符十六进制 SHA-256，从而可以安全使用一年 immutable 缓存。

新增只读缩略图接口 `/api/roms/:id/thumbnail?v=<full-sha256>`。公共游戏可匿名读取缩略图；私有游戏沿用 ROM 的访问控制。接口不接受文件路径参数，校验 active ref、完整 64 字符十六进制 SHA-256 与实际路径必须位于配置的缩略图根目录；版本不匹配返回 404 且不使用 immutable 缓存，匹配时返回 `image/webp`、以完整资产 SHA 为 ETag，并返回一年 immutable 缓存。

ROM 文件改为 build-addressed 接口 `/api/rom-builds/:buildId/file/<setName>.zip`，从 `archiveAssetId` 读取不可变资产。普通用户只能读取自己可访问 ROM 的 active build；房主可凭仍有效的房间会话读取该房间锁定的旧 build；任意已退休 build 不因猜中 ID 而公开。核心、DAT 与 BIOS 使用带 artifact/hash 的只读接口，播放器始终按 build 返回的 artifact URL 加载，旧 release 目录不再是资产真相源。

普通 `/api/roms/upload` 仍保留大小上限，避免公网账户任意占满磁盘。普通上传在一个事务中创建/复用逻辑 `roms`、选择服务器允许的平台默认 core artifact、写入内容寻址 ROM 资产和一个 `manual` build，再设置 `activeBuildId`；private manual build 可保持 `unverified` 并供上传者自测，但未经 accepted validation 不得公开。删除默认软删除逻辑 ROM；有活动房间、runtime child、存档或历史引用的 build/资产不得硬删。恢复、版本列表、管理页和现有 `/mine`/`public` API 都从 active build 与 build history 读取，不再读 `roms.filePath`。用户提供的公共整包通过服务器上的可信导入 CLI 写入，不受单文件 100MiB 限制，这也覆盖包内 12 个超过 100MiB 的候选文件。

## 批量导入流水线

### 1. 暂存和解包

- 在本地生成批次 ID、源文件 SHA-256 和完整文件清单。
- 提取并保留 `roms/`、`sshots/`、`ini/`、`cheats/`、`eeprom/`、`tracklst/`、`blend/` 和 BIOS；包内没有数据库，`saves/`、`capture/`、`recinput/` 是空目录。任何 EXE、DLL、BAT 都只记录哈希，不执行。
- 解包路径必须是新建的批次目录，并拒绝绝对路径、`..` 路径穿越和符号链接。

辅助文件进入批次的 `auxiliary/` 留档，不自动注入运行时。35 个 EEPROM/存档样本已完成格式审计：9 个 `.epm` 是 128-byte raw EEPROM，可按 exact MAME2003-Plus shortname 转成 `<shortname>.nv` 候选；26 个 `.srm` 是 Kawaks RLE 容器，均能无损解码成 65,536-byte Neo Geo backup RAM，其中 25 个有 exact bundled FBNeo shortname，可转成 `<shortname>.fs` 候选，`kof99nd` 因没有 exact driver 只能原样留档。`bangbead.srm` 与 `mslug4.srm` 的源文件和解码结果完全相同，必须单独做语义启动验证。当前 35 个样本的 `runtimeVerified` 全为 false，所以本次先完整携带原件、源/解码哈希和转换清单，不能写入现有 save-state API，也不能覆盖任何用户文件。

本次发布明确只留档这些 NVRAM 原件、解码候选和转换清单，不实现 seed 注入，也不新增 SRAM/NVRAM API；这样不会把未实机验证的数据混进现有 `.state` 生命周期。未来若单独实现 seed 功能，必须同时补齐 Nostalgist `sram` 输入、`saveSRAM()`、原子持久化、按用户+romBuild+core+seed 的永久 `seedApplied` 墓碑，以及用户删除/重置后不自动重播种的语义，经过独立设计与测试后才能启用。包内 `neogeo.zip`、`Uni-Bios.zip` 同样完整留档，但运行时 BIOS 仍以已验证的项目 BIOS 为基线，缺失成员可以按哈希补充，不能整包盲目覆盖。

### 2. 元数据生成

- set 名取 ZIP 文件名的小写 basename。
- 标题、parent/clone、ROM 名称、大小和 CRC 使用提交 `2f41022` 的精确 FBNeo Arcade DAT；旧短名只有在成员 CRC 能唯一映射到目标 driver 时才采用显式别名。
- 截图按不区分大小写的同名 basename 匹配；优先级固定为 exact basename、显式 legacy alias、exact DAT parent fallback、已审计的唯一源容器 reference。最后一种只允许在该 driver 的全部关键字节能唯一追溯到对应源 ZIP 时使用，`matchKind=source_reference` 并在卡片上明确标“参考图”，不能把来源图计为 exact。`Rotd` 的 BMP/PNG 双份采用 BMP 作为一致来源。
- 494 个截图文件已全部通过解码检查：493 BMP + 1 PNG、493 个唯一 basename，0 坏图、0 空白/近空白、0 透明图；15 张非标准尺寸统一使用 4:3 `object-fit: contain`，不拉伸。
- 当前 277 个 FBNeo 可重建条目已有 100%“可展示图片”覆盖：216 exact、8 alias、53 parent，0 missing；只有 216 项计入 exact 覆盖率。离线转成 WebP q80；同一像素内容的七组图片通过内容寻址资产复用。
- MAME 增量 97 个 CPS1 条目中，77 个有 exact/安全别名截图；其余 20 个均能唯一追溯到至少一个带截图的源容器，因此可以补 `source_reference`，但 manifest 与 API 必须返回实际来源和匹配等级。
- 折叠别名后的 282 个 FBA 增量条目中，162 个有直接同名截图，282/282 都有选中源包截图；没有直接图的 120 个只能作为 `source_reference`，不能计入 exact 覆盖率。
- 因此 656 个静态候选都有可展示图片：463 个 exact/显式 alias/直接同名，53 个 parent fallback，140 个 source reference，0 个缺图；API 与卡片必须保留这三个可信度层级，不能把 100%“有图”写成 100% exact。
- 每个 ROM 和缩略图计算 SHA-256，写入机器可读 `manifest.json` 和人类可读 `report.md`。

### 3. 兼容性分类

- `bios`：`neogeo.zip` 等 BIOS，不进入游戏卡片。
- 静态 `complete`：exact contract 所需 parent/BIOS/key/ROM 字节齐全并已生成规范 archive，但尚不代表可公开。
- 静态 `blocked`：理论支持，但缺 parent、BIOS、key 或 ROM 成员，不能生成完整 archive。
- 静态 `unsupported`：锁定核心没有对应驱动或明确不兼容。
- 计算 `unverified`：静态完整，但没有 accepted passed/failed validation；没有跑过或只有超时/inconclusive 都属于此状态。
- 计算 `ready`：静态完整并有 accepted `passed` validation；可以是原版、clone、hack 或 bootleg。
- 计算 `blocked`：静态 blocked，或静态完整但 accepted validation 明确失败。

WinKawaks 1.65 使用旧式 merged/decrypted ROM 集，ZIP 不自动等同于当前 FBNeo canonical set。静态对比已经发现 CPS2 缺现代 `.key`、部分图形 ROM CRC 不同，CPS1 缺部分现代 DAT PLD 条目，KOF97 和 Metal Slug 3/4/5 等同名 ZIP 还混装多个版本。混装成员不是默认删除项：导入器绑定线上 `fbneo.wasm` 与精确 DAT 哈希，把它们作为潜在 HACK/clone 字节来源；能按 exact DAT 唯一重建的每个 driver 分别输出规范 ZIP，无法唯一归属或缺依赖的原始候选才输出到 `quarantine/`。

FBNeo 初次精确审计得到 277 个可重建 driver。布局采用混合策略：157 个顶层条目使用 `standalone`；120 个 clone 中，98 个的直接 parent 也能从本包重建，使用 `split` 以复用 parent；其余 22 个使用 `standalone`。所有 clone 都只有一层直接 parent，没有当前播放器无法覆盖的多层依赖。该布局把候选游戏 ZIP 的未压缩成员总量从约 10.09GB 降到约 6.33GB，同时保留每个 HACK/bootleg 的独立卡片。

MAME2003-Plus 精确静态审计额外得到 97 个 CPS1 driver，且与上述 277 个 FBNeo shortname 零重叠；它们先全部按 exact DAT 输出 `standalone` build，只有未来单独验证 split 依赖链后才允许改布局。它们同样只是待启动验证的候选，不能在静态审计后直接标记为 `ready`。CPS2 在 FBNeo 与 MAME 下目前都是 0/41 可直接重建：其中 38 个物理源包除各自缺少一个精确 20-byte `.key` 外其余字节完整；`1944`、`19xx`、`avsp` 还存在额外程序或图形 ROM 代际差异。缺 key 或缺 ROM 的集合继续留在 `blocked`，不会为了凑数量使用同名错误内容。

FBA2012 专用 CPS1/CPS2 与全量核心使用旧 decrypted set contract，三核心并集可静态重建 398 个 driver；相对 FBNeo+MAME 基线新增 304 个 shortname，折叠 22 个字节合同完全相同的旧名别名后纳入 282 个 FBA driver 行：CPS1 42、CPS2 240，关系为 44 parent、232 clone、1 hack、5 bootleg。它覆盖 34/35 个物理 CPS1 源包和 41/41 个物理 CPS2 源包，`ffightj3` 是唯一没有 FBA driver/匹配 CRC 的 CPS1 源名。FBA build 先全部使用 `standalone`；同一 driver 优先选专用 CPS1/CPS2 artifact，全量核心只补专用核心缺项。该结果解决的是旧集合的静态 byte contract，不代表 41 个 CPS2 已经通过 Emscripten 启动、输入、音频或存档验证。

即使已经取得精确 DAT，DAT 静态匹配仍不能代替运行期验证。每个拟公开 set 都必须使用 build 锁定的 core、BIOS 和浏览器运行时执行自动启动冒烟，确认核心进入有效画面且没有 missing ROM、CRC、BIOS 或 key 错误；未实际跑过的静态完整条目保持 `unverified`。

启动冒烟不得再调用系统 Chrome/Edge，也不得用 `127.0.0.1` 文件服务器发送 ZIP。测试固定使用已校验哈希的 Playwright bundled Headless Shell；每个 case 使用独立 `user-data-dir`，`acceptDownloads=false`、阻止 service worker 和扩展，并通过虚拟域名的 `context.route()` 从本地路径直接 fulfill HTML、JS、WASM、ROM 与 BIOS。所有非白名单请求一律 abort，ROM/BIOS 响应不带 `Content-Disposition`。正式跑 ROM 前先执行无 ROM 的 1KiB canary，必须证明 download 事件为 0、隔离 downloads 目录为空、无监听端口、无 TCP 请求及外部下载器进程，才允许进入批量启动验证。

核心选择遵循固定优先级：先按 `fbneo` 精确 DAT 重建；未命中的旧 CPS1/CPS2 再按 `mame2003_plus`；仍未命中时使用已审计的 `fbalpha2012_cps1` / `fbalpha2012_cps2`，专用核心未覆盖才用 `fbalpha2012` 全量核心。FBA 三核心尚未进入当前项目，虽然源码/runtime contract/JS/WASM 哈希已经锁定，仍须先通过隔离启动冒烟才登记为启用的版本化 `core_artifacts`。不能因为旧核心静态兼容 Kawaks 就盲目发布；每个 build 引用确切 artifact，播放器必须按 build 加载对应 JS/WASM 与 BIOS，重跑必须得到同样结果。

### 4. 幂等写入

- 导入 CLI 默认 `--dry-run`，输出新增、更新、跳过、阻止和冲突计数，不修改数据库。
- 正式导入前使用 better-sqlite3 在线 backup API 创建包含 WAL 最新状态的一致性灾难恢复备份；禁止在线时只复制 4KiB 的 `app.db`。该备份只在发布写入尚未重新开放前发生灾难时恢复，不作为日常批次回滚手段。
- 文件先写入内容寻址临时名，校验哈希后原子重命名；数据库事务写入 core artifact、逻辑 ROM、不可变 build、资产引用和 `import_operations` 日志。提交失败时只删除本批次新建且引用数为零的文件，旧文件不动。
- 重跑同一批次时，相同 build/content 指纹直接跳过；同一逻辑 ROM 内容或核心变化时创建新的不可变 build，只有操作者显式发布才切换 `activeBuildId`，不原地覆盖旧 build，也不新增重复卡片。
- `import_operations` 为每个创建、链接、active-build 切换和现有七款字段/缩略图变更保存 before/after。正常回滚按逆序只撤销本批次操作，并在删除底层文件前检查 build、room、save 和 asset refcount；不会覆盖导入期间或之后新建的房间、存档和其他用户数据。
- 导入器使用专用公共目录所有者（现有管理员用户 ID），不把 241 个文件伪装成普通 HTTP 上传。

现有七个 set 先从线上 JS/WASM、ROM 与 BIOS 指纹创建 legacy core artifact/build，并令原 `roms` ID 的 `activeBuildId` 指向它。导入默认 `skip-existing`：内容指纹一致时保留 legacy build，只新增缩略图引用；内容不同则创建未发布候选 build 并记录冲突，绝不覆盖已经实测可玩的线上文件。

## 传输与生产发布

5GB 整包不通过 241 次 HTTP 上传，也不把原始 RAR 交给生产应用在线解包。生产侧分成两层：加密原始 `W165_709.7z` 作为不可变 cold source 完整留档，保留包内所有 ROM、截图、INI、cheat、EEPROM、BIOS 和其他文件；本地 importer 另生成只供运行使用的规范化 ZIP、WebP、manifest 与报告。这样原始资料一份不少，播放器又不必直接消费旧 Kawaks 混装集合。已发布条目的 normalized 资产与 cold source 分开计数，不用把 241 个内层源 ZIP 再单独复制一遍；`blocked/unsupported/conflict` 通过原始归档成员路径、CRC 和 SHA 可追溯，只有诊断需要时才解出单个隔离副本。

当前链路的 SFTP subsystem 已实测出现认证成功后长时间无响应，不能作为唯一传输方案。批次先在本地打成可独立校验的 64MiB 或 128MiB 固定块，每块记录 SHA-256；使用 legacy SCP 协议经现有反代机 `43.159.2.240` 做 `ProxyJump`，直接写入应用机 `160.236.110.53`。失败块自动重试，远端已有且哈希一致的块直接跳过。所有块到齐后才在应用机顺序合并，核对完整批次 SHA-256，并原子移动到 `shared/data/import-staging/<batch-id>/`。代理机只转发 SSH 流量、不落 ROM 副本；整个过程一次断线最多重传一个块，不新增公网端口，也不改现有 Nginx 上传限制。

8MiB 样本已完成三方哈希核验：本地直传应用机端到端仅约 `0.097MiB/s`，经反代机 `ProxyJump` 可达约 `3.068MiB/s`，快约 31.6 倍。原始归档单独传输约需 27 分钟；正式批次还包含 normalized 运行资产，因此上传前必须由最终 manifest 重新计算总字节和 ETA，不能继续把 4.875GiB 当成整个发布量。按块级续传执行，即使实际总量接近两倍，也只重传失败块并可跨会话继续。

生产流程：

1. 在应用机创建独立导入暂存目录，验证剩余空间和源哈希。
2. 构建包含迁移、API、前端和导入 CLI 的新 release；先在数据库副本上完成迁移、演练导入和启动抽样，不切换 `current`。演练产物只使用 set/hash/fingerprint 等自然键，不保存准备直接重放到 live DB 的数字 ID。
3. 进入短暂维护/写入冻结，等待活动写事务结束；使用 SQLite 在线 backup API 备份此刻 live DB，并保存当前 release、七个 legacy build、资产引用和文件哈希快照。
4. 在仍冻结写入的 live DB 上重新校验所有唯一键、当前 `activeBuildId`、文件哈希和操作日志 before 条件，再应用迁移并以事务重新执行导入；任何条件与副本演练不一致都中止，而不是盲目重放。成功后切换需要发布的 `activeBuildId`，原子切换 `current` 并重启现有 systemd 服务。
5. 完成服务、核心、图库、房间和缩略图验收后再解除写入冻结；保留原有自启、健康检查和 SSH 隧道，反代 Nginx 只复用既有站点文件，不改其他站点。
6. 若在解除写入冻结前失败，可以把 `current` 指回旧 release 并恢复灾难备份；旧 release 的“可操作回退”只保证到这一闸门。新版本一旦重新接受用户写入，旧 release 与旧 schema 不再作为任意时刻回退方案，只允许前向修复或按 `import_operations` 逆向回滚本批次，禁止整库恢复覆盖新房间或新存档。批次文件保留在隔离目录供诊断。

## 错误处理和可观察性

- 图库 API 不因单个缩略图丢失而失败，返回占位图并记录 set 名。
- 导入报告必须逐项列出机器可读 `failureCode`、失败阶段、预期依赖、实际缺失成员、证据路径和最终状态。
- 启动冒烟设置单游戏超时；超时只追加一条 `inconclusive` validation run，不修改 build，也不中止整个候选批次。
- 传输、解包、转换、哈希、数据库导入和生产抽样均写入批次日志；日志不记录压缩包密码、会话 Cookie 或 SSH 私钥。
- 公共图库不显示 `blocked` / `unsupported`，管理端可以查看各状态计数和原因。

## 测试策略

### 单元与服务测试

- 先写失败测试，覆盖 150ms 投币/开始点击、boot 时冻结映射、可靠 controls channel、session epoch+sequence 去重/ACK/重试、断线与卸载释放键、快速双击防重入、加载/错误/全屏状态工具栏持续可见。
- 覆盖 ROM+active build 序列化、多核心 artifact 选择、build fingerprint 唯一性、append-only validation/acceptance 状态映射、跨 ROM active build/thumbnail 复合外键拒绝、build-addressed 文件授权、创建房间的服务端 ready 校验、房间固定 build、旧 build 退休保护、云端与本地 save-state build 指纹隔离、split/standalone 两条挂载路径。
- 覆盖普通上传创建 manual build、private unverified 自测、公开前 validation 闸门、软删除/恢复、runtime parent/房间/存档引用阻止硬删，以及管理端版本历史。
- 覆盖缩略图内容寻址、共享引用回滚、`matchKind`/参考图标签、路径边界、ETag/缓存和私有图访问控制。
- 覆盖 manifest 解析、标题别名、规范文件名、幂等重跑、哈希冲突、进程中断状态恢复、操作日志逆向回滚、回滚后保留新房间/存档，以及 dry-run 无写入。
- 覆盖 Kawaks RLE 解码固定向量、`.fs`/`.nv` 候选目标命名、`kof99nd` 禁止猜测映射，并断言本次导入不会把任何候选写入 save-state、SRAM 或 NVRAM 运行目录。

### 前端测试

- 图库在 exact/alias/parent/source-reference/占位图、图片加载失败、长标题、至少 500 条多核心 variant 数据和窄屏下都保持稳定布局。
- 键盘导航能到达投币、开始、按键设置、全屏等按钮；减少动态效果设置生效；进入 player 容器全屏后工具栏仍可见。

### 真实核心与生产验收

- 使用实际 bundled FBNeo、`neogeo.zip` 和一份已授权测试 ROM，显式 `keydown → 150ms → keyup`，断言 `CREDIT 00 → 01`，再验证 Enter 开始。
- 每个启动 case 保存核心日志、浏览器 console/pageerror/requestfailed、路由账本、关键资产 SHA、采样帧和最佳证据图；通过必须同时满足核心进入 running、canvas 尺寸非零、没有 missing ROM/key/BIOS/CRC、出现非黑有效帧且多帧有像素变化。明确内容错误不重试，renderer crash 或超时只允许使用全新 profile 重试一次。
- 本机先以单并发运行 canary 和 3–5 个代表 set；全量候选优先放到隔离的远程 Linux Headless Shell worker，避免批量验证影响用户桌面或下载器。
- 验证流水线先全量跑过每个拟公开条目，再人工抽查 Neo Geo、CPS1、CPS2 以及原版、clone、HACK、bootleg 各至少一个；任何 CPS2 未通过 key 校验不得计为成功。
- 建一个房间，用第二浏览器验证访客点击投币/开始控制 P2，而房主按钮仍控制 P1；再切换图库 active build，确认原房间仍锁定旧 build，且房间内不能静默换版本。
- 核对公共 API 条目数、缩略图 200 响应数、无重复逻辑 `(userId, platform, setNameNormalized)`、build/core 指纹、服务状态、健康检查定时器和 Nginx 站点测试。

## 完成标准

- 工具栏在加载、运行、等待、错误和 player 全屏状态都固定可见；投币和开始按钮在单机、房主和访客角色下按冻结映射与 `control-pulse` 设计工作。
- 公共图库完成 CRT 霓虹改版，并为每个公开 variant 显示带 `matchKind` 的截图、明确标注的参考图或占位图。
- 241 个实际源 ZIP 全部进入可审计批次；从全局字节池派生的每个原版、clone、HACK 与 bootleg 条目都有标题、关系、截图来源、内容哈希和最终兼容状态。
- 所有 `ready` build 被幂等导入并可按其确切 core artifact 启动；房间和存档锁定 build；所有未发布条目都有机器可读失败码和具体原因，不能用“约 600 个”替代实际文件计数。
- 现有七款游戏、数据库、存档、BIOS、房间功能、Nginx 其他站点以及 systemd 自启保活不发生回归。
- 在解除写冻结前有可操作的旧 release + SQLite 灾难恢复点；解除后有经过验证的前向修复和批次操作日志回滚清单，不承诺旧 schema 任意时刻回退。
