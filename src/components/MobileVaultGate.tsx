import { useCallback, useEffect, useState } from "react";
import {
  createVault,
  defaultVaultDir,
  listVaults,
  storageWritable,
  vaultHomeGet,
  vaultHomeSetFromPath,
  type VaultInfo,
} from "../lib/api";
import { IconCalendarPlus, IconFolder, IconPlus, IconSettings, IconSparkles, IconX } from "./icons";

/**
 * 移动端仓库入口：基础目录未设置时是**引导页**，设置后是**仓库列表页**。
 *
 * 两个呈现形态：
 *   - 首次启动且没有仓库时，嵌在编辑区空状态里（App 传 `embedded`）；
 *   - 点「打开其他仓库」时作为浮层（App 传 `onClose`）。
 *
 * 「跳过」走 app 私有目录兜底（A0 行为），选择器只用来取路径——选完即把
 * content:// 树 URI 换算成真实路径，之后全部是原生文件读写。
 */

const SKIP_KEY = "quicknote.vaultHomeSkipped";

export function vaultHomeSkipped(): boolean {
  return localStorage.getItem(SKIP_KEY) === "1";
}

function formatWhen(ms: number): string {
  if (!ms) return "空仓库";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return "今天编辑过";
  if (days === 1) return "昨天编辑过";
  if (days < 30) return `${days} 天前`;
  return new Date(ms).toLocaleDateString();
}

export interface MobileVaultGateProps {
  /** 选中/新建仓库后回调（App 走 switchVault）。 */
  onOpen: (path: string) => void;
  /** 浮层形态的关闭按钮；嵌入形态不传。 */
  onClose?: () => void;
  /** 逐仓库查询同步是否开启。0.33.0 停点1 反馈：同步状态是按仓库拆分的，
      单值「当前同步仓库名」表达不了多仓库同时开启——A 仓库开了同步、再点
      B 的「开启同步」后 A 卡片会退回按钮态，用户看不出哪些仓库真的开着。 */
  isVaultSyncEnabled: (path: string) => Promise<boolean>;
  /**
   * 卡片上的「开启同步」：App 侧先 switchVault(该仓库) 再开同步再回列表——
   * 同步状态是单仓库模型（游标/哈希跟仓库走），必须切过去才能正确启用。
   * （App 的实现是异步链，resolve 时 enabled 可能尚未落盘，状态徽标由
   * 本组件延迟补查追上。）
   */
  onEnableSync: (path: string, name: string) => Promise<void>;
  /** 同步账号是否已配置（未配置时不显示同步开关，卡片只给引导文案）。 */
  syncConfigured: boolean;
  /** 引导第三步：保存同步账号信息（server/username/password）。跳过则不调。 */
  onConfigureSync: (serverUrl: string, username: string, password: string) => void;
  /** 批量同步选中的仓库（App 侧串行跑独立引擎，返回完成）。 */
  onSyncSelected: (paths: string[]) => Promise<void>;
  /** 批量同步进行中的描述（空串 = 空闲）；非空时列表禁交互。 */
  syncBatchLabel: string;
  /** 上一批同步失败的仓库（非空显示「重试」入口）。 */
  syncFailedPaths: string[];
  /** 重试失败的仓库。 */
  onRetrySyncFailed: () => void;
  /** 枚举云端当前用户的全部仓库（账号已配置时调用）。 */
  listCloudVaults: () => Promise<Array<{ name: string; version: number }>>;
  /** 0.33.1 主页重构：打开设置（主页顶栏齿轮；无仓库打开时主页是唯一界面，
      设置只能从这里进）。不传则不渲染齿轮。 */
  onOpenSettings?: () => void;
}

export function MobileVaultGate({
  onOpen,
  onClose,
  onOpenSettings,
  isVaultSyncEnabled,
  onEnableSync,
  syncConfigured,
  onConfigureSync,
  onSyncSelected,
  syncBatchLabel,
  syncFailedPaths,
  onRetrySyncFailed,
  listCloudVaults,
}: MobileVaultGateProps) {
  const [home, setHome] = useState<string | null | undefined>(undefined); // undefined = 查询中
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  /** 「所有文件访问」授权状态（真值 = 主存储可写探测）。 */
  const [granted, setGranted] = useState<boolean | null>(null); // null = 查询中
  /** 建议目录输入（默认 Documents/QuickNote）。 */
  const [homeDraft, setHomeDraft] = useState("/storage/emulated/0/Documents/QuickNote");
  /** 多选模式（批量同步）：选中的仓库路径集合。 */
  const [multiMode, setMultiMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 引导子步骤：2=目录（授权通过后）；3=云同步（可选，保存/跳过后进列表）。 */
  const [onboardStep, setOnboardStep] = useState<2 | 3>(2);
  /** 云端仓库列表（账号配置后自动拉取；本地已有 → 标记）。 */
  const [cloudVaults, setCloudVaults] = useState<Array<{ name: string; version: number }> | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  /** 「重新加载」按钮的触发器（§十二：失败给轻量提示+重试，不动同步逻辑）。 */
  const [cloudTick, setCloudTick] = useState(0);
  const [pullingName, setPullingName] = useState<string | null>(null);
  const [serverDraft, setServerDraft] = useState("");
  const [userDraft, setUserDraft] = useState("");
  const [passDraft, setPassDraft] = useState("");
  /** 卡片 ⋯ 菜单打开中的仓库路径（移除仓库入口）。 */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 每仓库的同步开启状态（已开启仓库的路径集合）。
      0.33.0 停点1：逐仓库查 enabledForVault，多选同步时同样按它显示徽标。 */
  const [syncOnPaths, setSyncOnPaths] = useState<Set<string>>(new Set());

  const refreshSyncOn = useCallback(async () => {
    const entries = await Promise.all(
      vaults.map(async (v) => [v.path, await isVaultSyncEnabled(v.path).catch(() => false)] as const),
    );
    setSyncOnPaths(new Set(entries.filter(([, on]) => on).map(([path]) => path)));
  }, [vaults, isVaultSyncEnabled]);

  // 仓库列表或查询函数变化时重查；点「开启同步」后的延迟补查也走这里
  useEffect(() => {
    void refreshSyncOn();
  }, [refreshSyncOn]);

  /** 桥（MainActivity 注入；桌面/旧包没有）。 */
  const bridge = (): Record<string, CallableFunction> | null =>
    (window as unknown as Record<string, unknown>).qnAndroid as
      | Record<string, CallableFunction>
      | undefined
      ?? null;

  const probeGranted = useCallback(async () => {
    const b = bridge();
    if (!b) {
      // 无桥（理论上不在 Android 上）：探测命令兜底
      setGranted(await storageWritable().catch(() => false));
      return;
    }
    setGranted(Boolean(b.canAccessAllFiles()));
  }, []);

  useEffect(() => {
    void probeGranted();
    // 从系统授权页回来时（visibilitychange）自动重探
    const onVis = () => {
      if (document.visibilityState === "visible") void probeGranted();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [probeGranted]);

  const requestAccess = () => {
    const b = bridge();
    if (b) b.requestAllFilesAccess();
  };

  /** 用建议目录（可改）设置基础目录：建目录 + 可写探测 + 写指针 → 进同步引导。 */
  const useSuggestedHome = async () => {
    setError(null);
    setHint(null);
    setBusy(true);
    try {
      const real = await vaultHomeSetFromPath(homeDraft.trim());
      localStorage.removeItem(SKIP_KEY);
      setHome(real); // step3 的渲染条件依赖 home（否则落回引导页空白）
      setOnboardStep(3);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 引导第三步：保存同步账号（enabled 留待在仓库上开启——切仓库会归零游标但保留账号）。 */
  const saveSyncInfo = () => {
    if (!serverDraft.trim() || !userDraft.trim() || !passDraft.trim()) {
      setError("服务器地址、账号、密码都需要填写");
      return;
    }
    onConfigureSync(serverDraft.trim(), userDraft.trim(), passDraft.trim());
    void reload();
  };

  /** 被移除（隐藏）的仓库：0.33.1 用户反馈「添加删除仓库功能」——仅从列表
      移除、**文件保留在磁盘**（不做危险的真实删除）；localStorage 持久。 */
  const hiddenPaths = (): string[] => {
    try {
      const raw = JSON.parse(localStorage.getItem("quicknote.vaults.hidden") ?? "[]");
      return Array.isArray(raw) ? raw.filter((p) => typeof p === "string") : [];
    } catch {
      return [];
    }
  };
  const removeVaultFromList = (path: string) => {
    try {
      localStorage.setItem(
        "quicknote.vaults.hidden",
        JSON.stringify([...new Set([...hiddenPaths(), path])]),
      );
    } catch {
      // 存不进去就只隐藏本轮
    }
    setMenuFor(null);
    void reload();
  };

  const reload = useCallback(async () => {
    setError(null);
    const got = await vaultHomeGet().catch((e) => {
      setError(String(e));
      return null;
    });
    setHome(got);
    if (!got) {
      setVaults([]);
      return;
    }
    const list = await listVaults().catch((e) => {
      setError(String(e));
      return [] as VaultInfo[];
    });
    const hidden = new Set(hiddenPaths());
    setVaults(list.filter((v) => !hidden.has(v.path)));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 云端仓库枚举：账号已配置时自动拉取（列表页与拉取区共用）
  useEffect(() => {
    if (!syncConfigured) {
      setCloudVaults(null);
      return;
    }
    let cancelled = false;
    listCloudVaults()
      .then((list: Array<{ name: string; version: number }>) => {
        if (!cancelled) {
          setCloudVaults(list);
          setCloudError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setCloudVaults([]);
          setCloudError(String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [syncConfigured, listCloudVaults, cloudTick]);

  /** 点「开启同步」后追状态：App 侧是「切仓库→等 sync.ready→updateConfig」的
      异步链，onEnableSync resolve 时 enabled 可能尚未落盘——延迟两轮补查，
      让状态徽标尽快追上（0.33.0 停点1 反馈「点了开启同步状态没变」）。 */
  const enableSyncAndRefresh = async (path: string, name: string) => {
    await onEnableSync(path, name).catch(() => {});
    for (const ms of [800, 2500]) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      void refreshSyncOn();
    }
  };

  /** 拉取一个云端仓库到本地（目录已存在直接同步）。 */  const pullVault = async (name: string) => {
    if (!name || pullingName || !home) return;
    setError(null);
    setPullingName(name);
    try {
      let path: string;
      try {
        path = await createVault(name);
      } catch (e) {
        if (String(e).includes("已存在")) {
          path = `${home}/${name}`;
        } else {
          throw e;
        }
      }
      await onSyncSelected([path]);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setPullingName(null);
    }
  };

  const skipToPrivate = async () => {
    setBusy(true);
    try {
      const dir = await defaultVaultDir();
      if (!dir) throw new Error("拿不到私有仓库目录");
      localStorage.setItem(SKIP_KEY, "1");
      onOpen(dir);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCreate = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const path = await createVault(name);
      setCreating(false);
      setDraft("");
      onOpen(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---------------- 引导第三步：云同步（可选） ----------------
  // home 已设但 onboardStep 停在 3：先于列表显示同步引导（跳过/保存都进列表）
  if (home !== null && onboardStep === 3 && !syncConfigured) {
    return (
      <div className="mv-gate">
        <div className="editor-empty-logo"><IconSparkles size={26} /></div>
        <h2>可选：开启云同步</h2>
        <p className="mv-lede">
          配置同步账号后，仓库可以与电脑端、其他设备共用同一份笔记。
          没有服务器也可以跳过，之后在 设置 → 云同步 里随时配置。
        </p>
        <div className="mv-sync-fields">
          <input type="text" inputMode="url" value={serverDraft} onChange={(e) => setServerDraft(e.target.value)} placeholder="服务器地址（如 http://your-server:8080）" />
          <input type="text" value={userDraft} onChange={(e) => setUserDraft(e.target.value)} placeholder="账号" />
          <input type="password" value={passDraft} onChange={(e) => setPassDraft(e.target.value)} placeholder="密码" />
        </div>
        {error && <p className="mv-error">{error}</p>}
        <div className="editor-empty-actions">
          <button type="button" className="btn" onClick={saveSyncInfo}>
            保存并继续
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => void reload()}>
            跳过，暂不同步
          </button>
        </div>
        <p className="mv-foot">保存后在仓库列表点仓库卡片上的「开启同步」即可让该仓库自动同步。</p>
      </div>
    );
  }

  // ---------------- 引导页（基础目录未设置） ----------------
  if (home === undefined) {
    return (
      <div className="mv-gate">
        <div className="editor-empty-logo"><IconSparkles size={26} /></div>
        <h2>Quick Note</h2>
        <p>正在准备仓库…</p>
      </div>
    );
  }
  if (home === null) {
    // 两步引导：①「所有文件访问」授权（真值=主存储可写探测，从授权页回来自动重探）
    // ②确认基础目录（默认建议 Documents/QuickNote，可改）——dialog 插件的目录
    // 选择器在 Android 上不可用，故不走「选择目录」而走「授权 + 建议目录」。
    const step = granted ? 2 : 1;
    return (
      <div className="mv-gate">
        <div className="editor-empty-logo"><IconSparkles size={26} /></div>
        <h2>欢迎使用 Quick Note</h2>
        <p className="mv-lede">
          选择一个<strong>基础目录</strong>，它里面的每个子文件夹都是一个独立仓库
          （与电脑端、Obsidian 通用同一份 Markdown 文件）。
        </p>
        <ol className="mv-steps">
          <li className={step > 1 ? "done" : "current"}>
            {step > 1 ? "✓ " : ""}允许「所有文件访问」权限
            {granted === false && (
              <button type="button" className="btn mv-step-btn" disabled={busy} onClick={requestAccess}>
                去授权
              </button>
            )}
          </li>
          <li className={step >= 2 ? "current" : ""}>
            确认基础目录：
            {step >= 2 && (
              <div className="mv-home-input">
                <input
                  type="text"
                  value={homeDraft}
                  onChange={(e) => setHomeDraft(e.target.value)}
                  placeholder="/storage/emulated/0/Documents/QuickNote"
                />
                <button type="button" className="btn" disabled={busy} onClick={() => void useSuggestedHome()}>
                  <IconFolder size={14} /> 使用此目录
                </button>
              </div>
            )}
          </li>
          <li>在仓库列表打开已有仓库，或新建一个。</li>
        </ol>
        {granted === false && <p className="mv-hint">点击「去授权」后在系统设置中打开「允许访问所有文件」开关，再返回本页。</p>}
        {hint && <p className="mv-hint">{hint}</p>}
        {error && <p className="mv-error">{error}</p>}
        <div className="editor-empty-actions">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void skipToPrivate()}>
            跳过（仅用应用私有目录）
          </button>
        </div>
      </div>
    );
  }

  // ---------------- 仓库列表页 ----------------
  return (
    <div className="mv-gate">
      <div className="mv-gate-head">
        {/* 0.33.0 批B（需求 §八）：头部两行——标题行（仓库 + 多选同步 + 关闭）
            与路径行（全宽省略）。多选同步从下方独立按钮收进头部。 */}
        <div className="mv-gate-title">
          <h2>仓库</h2>
          {syncConfigured && vaults.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost mv-multi-toggle"
              onClick={() => {
                setMultiMode((v) => !v);
                setSelected(new Set());
              }}
            >
              {multiMode ? "取消多选" : "多选同步"}
            </button>
          )}
          {/* 0.33.1 主页重构：设置入口（无仓库打开时主页是唯一界面）；关闭改 ✕ */}
          {onOpenSettings && (
            <button
              type="button"
              className="icon-btn mv-settings"
              title="设置"
              aria-label="设置"
              onClick={onOpenSettings}
            >
              <IconSettings size={16} />
            </button>
          )}
          {onClose && (
            <button type="button" className="btn btn-ghost mv-close" onClick={onClose} aria-label="返回仓库">
              <IconX size={15} />
            </button>
          )}
        </div>
        <span className="mv-home" title={home}>{home}</span>
      </div>
      {error && <p className="mv-error">{error}</p>}
      {syncBatchLabel && <p className="mv-hint">{syncBatchLabel}</p>}
      {!syncBatchLabel && syncFailedPaths.length > 0 && (
        <button
          type="button"
          className="btn mv-retry"
          onClick={() => void onRetrySyncFailed()}
        >
          ⟳ 重试失败的仓库（{syncFailedPaths.length}）
        </button>
      )}
      <div className="mv-list">
        {/* 0.33.0 停点1 第三轮（仓库页 UI 规范）：空状态给明确引导而非长段文案 */}
        {vaults.length === 0 && (
          <div className="mv-empty">
            <p className="mv-empty-title">还没有仓库</p>
            <p className="mv-empty-sub">创建一个仓库开始记录你的笔记</p>
          </div>
        )}
        {vaults.map((v) => (
          <button
            type="button"
            key={v.path}
            title={v.name}
            className={`mv-card${multiMode && selected.has(v.path) ? " is-picked" : ""}`}
            onClick={() => {
              if (multiMode) {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(v.path)) next.delete(v.path);
                  else next.add(v.path);
                  return next;
                });
                return;
              }
              onOpen(v.path);
            }}
          >
            {/* 0.33.0 停点1 第四轮：名称完整换行显示（用户两轮反馈都不接受截断，
                单行/两行省略都退回）；状态标签并入 meta 行右侧。图标必须
                flex:none——SVG 在 flex 行里默认可被长文本压缩变形 */}
            <span className="mv-card-name">
              <IconFolder size={16} />
              <span className="mv-card-name-text">{v.name}</span>
            </span>
            <div className="mv-card-meta">
              <span className="mv-card-meta-text">
                {v.noteCount} 篇 · {formatWhen(v.lastModified)}
              </span>
              {syncOnPaths.has(v.path) ? (
                <span className="mv-state">
                  <i className="mv-dot is-sync" />
                  同步开启
                </span>
              ) : syncConfigured ? (
                <span
                  className="mv-sync-toggle"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    void enableSyncAndRefresh(v.path, v.name);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.stopPropagation();
                      void enableSyncAndRefresh(v.path, v.name);
                    }
                  }}
                >
                  开启同步
                </span>
              ) : null}
            </div>
            {/* 0.33.1 用户反馈「添加删除仓库功能」：⋯ 菜单（仅从列表移除，文件
                保留在磁盘）；span role=button——button 里不能嵌 button */}
            {!multiMode && (
              <span
                role="button"
                tabIndex={0}
                className="mv-card-more"
                title="仓库操作"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor(v.path);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    setMenuFor(v.path);
                  }
                }}
              >
                ⋯
              </span>
            )}
          </button>
        ))}
      </div>
      {/* 卡片 ⋯ 菜单（0.33.1）：移除仓库 = 仅从列表移除、文件保留在磁盘 */}
      {menuFor && (
        <>
          <div className="menu-backdrop" onClick={() => setMenuFor(null)} />
          <div className="mv-card-menu" role="menu">
            <div className="mv-card-menu-name">
              {vaults.find((v) => v.path === menuFor)?.name ?? menuFor}
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={() => removeVaultFromList(menuFor)}
            >
              移除仓库（保留文件）
            </button>
            <button type="button" role="menuitem" onClick={() => setMenuFor(null)}>
              取消
            </button>
          </div>
        </>
      )}
      {multiMode && (
        <div className="mv-batch-bar">
          <button
            type="button"
            className="btn"
            disabled={selected.size === 0 || Boolean(syncBatchLabel)}
            onClick={() => {
              const paths = [...selected];
              setSelected(new Set());
              setMultiMode(false);
              void onSyncSelected(paths);
            }}
          >
            ⟳ 同步选中（{selected.size}）
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => { setMultiMode(false); setSelected(new Set()); }}>
            取消
          </button>
        </div>
      )}
      {creating ? (
        <div className="mv-create">
          <input
            autoFocus
            type="text"
            value={draft}
            placeholder="仓库名称"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitCreate();
              if (e.key === "Escape") setCreating(false);
            }}
          />
          <button type="button" className="btn" disabled={busy} onClick={() => void submitCreate()}>创建</button>
          <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>取消</button>
        </div>
      ) : (
        /* §五：新建仓库=独立居中的次级按钮（描边轻填充、≥44dp 触控）；
           「更改基础目录」退为弱化的文字链接 */
        <div className="mv-actions">
          <button type="button" className="mv-new-vault" onClick={() => setCreating(true)}>
            <IconPlus size={14} /> 新建仓库
          </button>
          <button
            type="button"
            className="mv-change-home"
            onClick={() => {
              // 改基础目录 = 清指针回引导页（引导页有授权探测与建议目录输入）
              void import("../lib/api").then((m) => m.vaultHomeClear()).then(() => reload());
            }}
          >
            更改基础目录
          </button>
        </div>
      )}
      {syncConfigured && (
        <div className="mv-pull">
          {/* 0.33.0 停点1 第三轮（仓库页 UI 规范 §六/§七/§十一/§十二）：
              行=名称(单行) + 状态点辅助信息 + 右侧统一尺寸操作钮（打开/拉取
              语义分明）；空态给短文案；失败给轻量提示+重新加载 */}
          <p className="mv-pull-title">云端仓库</p>
          {cloudError && (
            <div className="mv-cloud-error">
              <span>云端仓库加载失败</span>
              <button type="button" className="btn btn-ghost" onClick={() => setCloudTick((t) => t + 1)}>
                重新加载
              </button>
            </div>
          )}
          {cloudVaults === null && !cloudError && <p className="mv-empty-sub">正在获取云端仓库列表…</p>}
          {cloudVaults?.length === 0 && (
            <div className="mv-empty">
              <p className="mv-empty-title">暂无云端仓库</p>
              <p className="mv-empty-sub">在某个仓库上开启同步后，它会出现在这里</p>
            </div>
          )}
          {cloudVaults?.map((cv) => {
            const local = vaults.find((v) => v.name === cv.name);
            const pulling = pullingName === cv.name;
            return (
              <div key={cv.name} className="mv-cloud-row">
                <div className="mv-cloud-main">
                  <span className="mv-cloud-name">
                    <IconFolder size={16} />
                    <span className="mv-cloud-name-text" title={cv.name}>{cv.name}</span>
                  </span>
                  <span className="mv-cloud-meta">
                    <i className={`mv-dot${local ? " is-local" : pulling ? " is-pulling" : " is-cloud"}`} />
                    {local ? `已在本地 · ${local.noteCount} 篇` : `云端版本 ${cv.version}`}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn mv-cloud-btn"
                  disabled={pullingName !== null}
                  onClick={() => (local ? onOpen(local.path) : void pullVault(cv.name))}
                >
                  {pulling ? "拉取中" : local ? "打开" : "拉取"}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <p className="mv-foot">
        <IconCalendarPlus size={12} /> 配置同步账号后，在仓库内打开 设置 → 云同步 即可让该仓库自动同步。
      </p>
    </div>
  );
}
