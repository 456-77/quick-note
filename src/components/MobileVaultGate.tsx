import { useCallback, useEffect, useState } from "react";
import {
  createVault,
  defaultVaultDir,
  listVaults,
  pickDirectory,
  storageWritable,
  vaultHomeGet,
  vaultHomeSetFromUri,
  type VaultInfo,
} from "../lib/api";
import { IconCalendarPlus, IconFolder, IconPlus, IconSparkles } from "./icons";

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
  /** 当前开启了同步的云端仓库名（列表里对应目录名的卡片显示徽标）；null = 没开。 */
  syncActiveVaultName: string | null;
}

export function MobileVaultGate({ onOpen, onClose, syncActiveVaultName }: MobileVaultGateProps) {
  const [home, setHome] = useState<string | null | undefined>(undefined); // undefined = 查询中
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

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
    setVaults(list);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 选基础目录：SAF 选择器只取路径，Rust 侧换算真实路径并探测可写。 */
  const chooseHome = async () => {
    setError(null);
    setHint(null);
    const picked = await pickDirectory("选择仓库基础目录（其中的子文件夹各自是一个仓库）");
    if (!picked) return;
    setBusy(true);
    try {
      await vaultHomeSetFromUri(picked);
      localStorage.removeItem(SKIP_KEY);
      await reload();
    } catch (e) {
      const message = String(e);
      if (message.includes("不可写")) {
        // 授权需要去系统设置；回来后重探
        setHint(message);
        const ok = await storageWritable().catch(() => false);
        setHint(ok ? null : message);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
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
    return (
      <div className="mv-gate">
        <div className="editor-empty-logo"><IconSparkles size={26} /></div>
        <h2>欢迎使用 Quick Note</h2>
        <p className="mv-lede">
          选择一个<strong>基础目录</strong>，它里面的每个子文件夹都是一个独立仓库
          （与电脑端、Obsidian 通用同一份 Markdown 文件）。
        </p>
        <ol className="mv-steps">
          <li>首次使用需在系统设置中允许<strong>「所有文件访问」</strong>（下一步会提示）；</li>
          <li>选择目录，如 <code>Documents/QuickNote</code>；</li>
          <li>在列表中打开已有仓库，或新建一个。</li>
        </ol>
        {hint && <p className="mv-hint">{hint}：请在 系统设置 → 应用 → Quick Note → 权限 中允许「文件与媒体/所有文件访问」后重试。</p>}
        {error && <p className="mv-error">{error}</p>}
        <div className="editor-empty-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void chooseHome()}>
            <IconFolder size={14} /> 选择基础目录
          </button>
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
        <h2>仓库</h2>
        <span className="mv-home" title={home}>{home}</span>
        {onClose && (
          <button type="button" className="btn btn-ghost mv-close" onClick={onClose}>
            关闭
          </button>
        )}
      </div>
      {error && <p className="mv-error">{error}</p>}
      <div className="mv-list">
        {vaults.length === 0 && <p className="mv-lede">基础目录下还没有仓库。新建一个，或把电脑端的仓库文件夹放进来（USB / 网盘同步均可）。</p>}
        {vaults.map((v) => (
          <button
            type="button"
            key={v.path}
            className={`mv-card${syncActiveVaultName && syncActiveVaultName === v.name ? " is-syncing" : ""}`}
            onClick={() => onOpen(v.path)}
          >
            <span className="mv-card-name">
              <IconFolder size={15} /> {v.name}
            </span>
            <span className="mv-card-meta">
              {v.noteCount} 篇 · {formatWhen(v.lastModified)}
            </span>
            {syncActiveVaultName && syncActiveVaultName === v.name && (
              <span className="mv-badge">⟳ 同步开启</span>
            )}
          </button>
        ))}
      </div>
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
        <div className="editor-empty-actions">
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            <IconPlus size={14} /> 新建仓库
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void chooseHome()}>
            更改基础目录
          </button>
        </div>
      )}
      <p className="mv-foot">
        <IconCalendarPlus size={12} /> 配置同步账号后，在仓库内打开 设置 → 云同步 即可让该仓库自动同步。
      </p>
    </div>
  );
}
