import { useState, useEffect, useRef, useCallback } from "react";
import { KofiImage, WXImage } from "src/lib/utils/helpers_image";
import { createPortal } from "react-dom";
import { dump } from "src/lib/utils/helpers";
import { setIcon } from "obsidian";
import FastSync from "src/main";

import { UserDTO, SupportRecord, SupportPager } from "../lib/api/http_api_service";
import { LucideIcon } from "./note-history/lucide-icon";
import { $, getLocale } from "../i18n/lang";


export interface RemoteAuthConfig {
  api: string;
  apiToken: string;
  vault: string;
}

export type ClipboardImportResult =
  | { status: "success"; config: RemoteAuthConfig; message: string; allowManualInput: false }
  | { status: "clipboard_unavailable"; message: string; allowManualInput: true }
  | { status: "clipboard_read_failed"; message: string; allowManualInput: true }
  | { status: "invalid_config"; message: string; allowManualInput: false };

export function parseRemoteConfigText(rawText: string): RemoteAuthConfig | null {
  const withoutBom = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  const normalized = withoutBom.trim();
  if (!normalized) {
    return null;
  }

  let parsedData: unknown;
  try {
    parsedData = JSON.parse(normalized);
  } catch {
    return null;
  }

  if (typeof parsedData !== "object" || parsedData === null || Array.isArray(parsedData)) {
    return null;
  }

  const record = parsedData as Record<string, unknown>;
  if (!("api" in record) || !("apiToken" in record) || !("vault" in record)) {
    return null;
  }
  if (typeof record.api !== "string" || typeof record.apiToken !== "string" || typeof record.vault !== "string") {
    return null;
  }
  if (!record.api.trim() || !record.apiToken.trim()) {
    return null;
  }

  return {
    api: record.api,
    apiToken: record.apiToken,
    vault: record.vault,
  };
}

async function applyRemoteConfig(plugin: FastSync, config: RemoteAuthConfig): Promise<void> {
  if (plugin.settings.api != config.api || plugin.settings.apiToken != config.apiToken) {
    plugin.wsSettingChange = true;
  }
  plugin.settings.api = config.api;
  plugin.settings.apiToken = config.apiToken;
  plugin.settings.vault = config.vault;
  plugin.clipboardReadTip = $("setting.remote.paste_success");

  plugin.localStorageManager.clearSyncTime();
  await plugin.saveAndReloadServices();
  plugin.settingTab.refresh();

  window.setTimeout(() => {
    plugin.clipboardReadTip = "";
    plugin.settingTab.refresh();
  }, 2000);
}

export async function importRemoteConfigFromText(plugin: FastSync, text: string): Promise<ClipboardImportResult> {
  const config = parseRemoteConfigText(text);
  if (!config) {
    return {
      status: "invalid_config",
      message: $("setting.remote.invalid_config"),
      allowManualInput: false,
    };
  }

  await applyRemoteConfig(plugin, config);
  return {
    status: "success",
    config,
    message: $("setting.remote.paste_success"),
    allowManualInput: false,
  };
}

export async function pasteRemoteConfigFromClipboard(
  plugin: FastSync,
  clipboard: { readText?: () => Promise<string> } | null | undefined = typeof navigator !== "undefined"
    ? navigator.clipboard
    : undefined,
): Promise<ClipboardImportResult> {
  if (!clipboard || typeof clipboard.readText !== "function") {
    return {
      status: "clipboard_unavailable",
      message: $("setting.remote.clipboard_unavailable"),
      allowManualInput: true,
    };
  }

  let text: string;
  try {
    text = await clipboard.readText();
  } catch (err) {
    dump(err);
    return {
      status: "clipboard_read_failed",
      message: $("setting.remote.clipboard_read_failed"),
      allowManualInput: true,
    };
  }

  return importRemoteConfigFromText(plugin, text);
}

export const SettingsView = ({ plugin }: { plugin: FastSync }) => {
  const [isConnected, setIsConnected] = useState<boolean>(plugin.websocket.isConnected());
  const [userInfo, setUserInfo] = useState<UserDTO | null>(null);
  const [loadingUserInfo, setLoadingUserInfo] = useState<boolean>(false);
  const [pasteTip, setPasteTip] = useState<{ message: string; isError: boolean } | null>(() =>
    plugin.clipboardReadTip ? { message: plugin.clipboardReadTip, isError: false } : null
  );
  const [showManualPaste, setShowManualPaste] = useState<boolean>(false);
  const [manualConfigText, setManualConfigText] = useState<string>("");
  const iconRef = useRef<HTMLSpanElement>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    const listener = (status: boolean) => {
      if (isMounted.current) {
        setIsConnected(status);
      }
    };

    plugin.websocket.addStatusListener(listener);
    return () => {
      plugin.websocket.removeStatusListener(listener);
    };
  }, [plugin.websocket]);

  useEffect(() => {
    if (isConnected && !userInfo && !loadingUserInfo) {
      setLoadingUserInfo(true);
      plugin.api.getUserInfo()
        .then(data => {
          if (!isMounted.current) return;
          setUserInfo(data);
          setLoadingUserInfo(false);
        })
        .catch(err => {
          dump("Failed to fetch user info:", err);
          if (!isMounted.current) return;
          setLoadingUserInfo(false);
        });
    } else if (!isConnected && (userInfo || loadingUserInfo)) {
      setUserInfo(null);
      setLoadingUserInfo(false);
    }
  }, [isConnected, plugin.api, userInfo, loadingUserInfo]);

  useEffect(() => {
    if (iconRef.current) {
      iconRef.current.empty();
      setIcon(iconRef.current, isConnected ? "wifi" : "wifi-off");
    }
  }, [isConnected]);

  // 现代化的 Markdown 表格渲染，移动端自动转为卡片列表
  const renderMarkdownTable = (content: string) => {
    const lines = content.split('\n');
    const tableData = lines.filter(line => line.trim().startsWith('|') && line.trim().endsWith('|'));
    if (tableData.length < 2) return null;

    const parseRow = (row: string) => row.split('|').filter((_, i, arr) => i > 0 && i < arr.length - 1).map(s => s.trim());
    parseRow(tableData[0]);
    const bodyRows = tableData.slice(2).map(parseRow);

    // 解析链接并在新窗口打开
    const handleMethodClick = (htmlContent: string) => {
      const match = htmlContent.match(/href=['"]([^'"]+)['"]/);
      if (match && match[1]) {
        window.open(match[1], '_blank');
      }
    };

    return (
      <div className="fns-setup-methods">
        {bodyRows.map((row, i) => (
          <div key={i} className="fns-method-card" onClick={() => handleMethodClick(row[1])}>
            <div className="fns-method-icon">
              <span dangerouslySetInnerHTML={{ __html: i === 0 ? "🛠️" : "☁️" }} />
            </div>
            <div className="fns-method-info">
              <div className="fns-method-title">{row[0]}</div>
              <div className="fns-method-desc" dangerouslySetInnerHTML={{ __html: row[1] }} />
            </div>
            <div className="fns-method-arrow">→</div>
          </div>
        ))}
      </div>
    );
  };

  const handleClipboardClick = async () => {
    plugin.clipboardReadTip = "";
    try {
      const result = await pasteRemoteConfigFromClipboard(plugin);
      if (!isMounted.current) return;
      if (result.status === "success") {
        setShowManualPaste(false);
        setManualConfigText("");
        setPasteTip({ message: result.message, isError: false });
      } else {
        if (result.allowManualInput) {
          setShowManualPaste(true);
        }
        setPasteTip({ message: result.message, isError: true });
      }
    } catch (err) {
      dump(err);
    }
  };

  const handleManualApply = async () => {
    plugin.clipboardReadTip = "";
    try {
      const result = await importRemoteConfigFromText(plugin, manualConfigText);
      if (!isMounted.current) return;
      if (result.status === "success") {
        setShowManualPaste(false);
        setManualConfigText("");
        setPasteTip({ message: result.message, isError: false });
      } else {
        setPasteTip({ message: result.message, isError: true });
      }
    } catch (err) {
      dump(err);
    }
  };

  const handleManualCancel = () => {
    setShowManualPaste(false);
    setManualConfigText("");
    setPasteTip(null);
  };

  const activeTip = pasteTip ?? (plugin.clipboardReadTip ? { message: plugin.clipboardReadTip, isError: false } : null);

  return (
    <div className="fns-remote-config-container">
      <div className="fns-setup-group-card">
        <div className="fns-setup-content">
          {renderMarkdownTable($("setting.remote.setup_table"))}

          <div className="fns-action-group">
            <button type="button" className="fns-premium-btn" onClick={() => { void handleClipboardClick(); }}>
              <span className="fns-btn-icon">📋</span>
              {$("setting.remote.paste_config")}
            </button>

            {activeTip && (
              <div className={`fns-paste-toast${activeTip.isError ? " is-error" : ""}`}>{activeTip.message}</div>
            )}

            {showManualPaste && (
              <div className="fns-manual-paste-panel">
                <label className="fns-manual-paste-field">
                  <span className="fns-manual-paste-hint">{$("setting.remote.manual_paste_hint")}</span>
                  <textarea
                    className="fns-manual-paste-textarea"
                    rows={4}
                    value={manualConfigText}
                    onChange={(e) => setManualConfigText(e.target.value)}
                    placeholder={$("setting.remote.manual_paste_placeholder")}
                  />
                </label>
                <div className="fns-manual-paste-actions">
                  <button
                    type="button"
                    className="fns-manual-paste-btn mod-cta"
                    onClick={() => { void handleManualApply(); }}
                  >
                    {$("setting.remote.manual_paste_apply")}
                  </button>
                  <button
                    type="button"
                    className="fns-manual-paste-btn"
                    onClick={handleManualCancel}
                  >
                    {$("ui.button.cancel")}
                  </button>
                </div>
              </div>
            )}

            <div className={`fns-status-pill ${isConnected ? 'is-connected' : 'is-disconnected'}`}>
              <div className="fns-status-dot" />
              <span className="fns-status-label">
                {isConnected ? $("setting.remote.connected") : $("setting.remote.disconnected")}
              </span>
              {isConnected && userInfo && (
                <div className="fns-status-account">
                  <span className="fns-sep">/</span>
                  <span className="fns-account-name">{userInfo.username}</span>
                  <span className="fns-uid-badge">ID:{userInfo.uid}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


const SupportList = ({ plugin }: { plugin: FastSync }) => {
  const [records, setRecords] = useState<SupportRecord[]>([]);
  const [pager, setPager] = useState<SupportPager>({ page: 1, pageSize: 10, totalRows: 0 });
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState("amount_3m");
  const [hoverTooltip, setHoverTooltip] = useState<{ text: string, x: number, y: number, isMobile: boolean } | null>(null);
  // Track the supporter record selected for detail modal viewing
  // 跟踪被选择用于详情模态框展示的支持者记录
  const [selectedRecord, setSelectedRecord] = useState<SupportRecord | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const fetchRecords = useCallback(async (page = 1, sort = sortBy) => {
    if (!plugin.settings.api) {
      setLoading(false);
      setFetchError(true);
      return;
    }
    setLoading(true);
    setFetchError(false);
    try {
      const data = await plugin.api.getSupportRecordsPage(page, 10, sort, "desc");
      if (!isMounted.current) return;
      setRecords(data.list);
      setPager(data.pager);
    } catch (err) {
      dump("Failed to fetch support records:", err);
      if (!isMounted.current) return;
      setFetchError(true);
    } finally {
      if (isMounted.current) {
        setLoading(false);
      }
    }
  }, [plugin, sortBy]);

  useEffect(() => {
    void fetchRecords(1, sortBy);
  }, [fetchRecords, sortBy, getLocale()]);

  const getInitials = (name: string) => {
    if (!name) return "?";
    return name.charAt(0).toUpperCase();
  };

  const getAvatarColor = (name: string) => {
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
      '#F06292', '#AED581', '#FFD54F', '#4DB6AC', '#7986CB'
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  const getSupportLink = () => {
    const locale = getLocale();

    const fileNameMap: Record<string, string> = {
      "zh-cn": "Support.zh-CN.md",
      "zh-tw": "Support.zh-TW.md",
      "ko": "Support.ko.md",
      "ja": "Support.ja.md",
    };
    const fileName = fileNameMap[locale] || "Support.en.md";

    const baseUrl = "https://github.com/isdoge/fast-note-sync-service/blob/master/docs/";

    return baseUrl + fileName;
  };

  if (loading && records.length === 0) {
    return <div className="fns-support-loading">{$("setting.support.loading")}</div>;
  }

  return (
    <>
      <div className="fns-supporters-list-header">
        <div className="fns-supporters-title-group">
          <LucideIcon icon="trophy" size={16} />
          <span className="fns-supporters-title">
            {$("setting.support.list")}
            {plugin.settings.api && !fetchError && (
              <span className="fns-supporters-range">
                ({sortBy === 'amount_3m' ? $("setting.support.range_3m") : $("setting.support.range_all")})
              </span>
            )}
          </span>
        </div>
        {plugin.settings.api && !fetchError && (
          <div className="fns-support-controls">
            <div className="fns-support-sort-group">
              <button
                className={sortBy === 'amount_3m' ? 'is-active' : ''}
                onClick={() => setSortBy('amount_3m')}
              >
                {$("setting.support.sort_3m")}
              </button>
              <button
                className={sortBy === 'amount' ? 'is-active' : ''}
                onClick={() => setSortBy('amount')}
              >
                {$("setting.support.sort_amount")}
              </button>
              <button
                className={sortBy === 'time' ? 'is-active' : ''}
                onClick={() => setSortBy('time')}
              >
                {$("setting.support.sort_time")}
              </button>
            </div>
          </div>
        )}
      </div>

      {fetchError ? (
        <a href={getSupportLink()} target="_blank" rel="noreferrer" className="fns-supporters-github-link">
          <span className="fns-github-icon">
            <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
          </span>
          <span>{$("setting.support.list_link")}</span>
        </a>
      ) : records.length === 0 ? (
        <div className="fns-support-empty">{$("setting.support.empty")}</div>
      ) : (
        <>
          <div className="fns-supporters-container">
            {records.map((record, idx) => (
              <div
                key={idx}
                className="fns-support-row"
                onPointerEnter={(e) => {
                  if (e.pointerType === 'touch') return;
                  const msg = `${record.name || "Anonymous"}${record.message ? ': ' + record.message : ''}`;
                  setHoverTooltip({ text: msg, x: e.clientX, y: e.clientY, isMobile: false });
                }}
                onPointerMove={(e) => {
                  if (e.pointerType === 'touch') return;
                  setHoverTooltip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY, isMobile: false } : null);
                }}
                onPointerLeave={() => setHoverTooltip(null)}
                onClick={() => {
                  setSelectedRecord(record);
                }}
              >
                {/* Date */}
                <div className="fns-support-date">
                  {(record.time || "").split(' ')[0].substring(2) || "N/A"}
                </div>

                {/* Avatar */}
                <div
                  className="fns-support-avatar"
                  style={{ backgroundColor: getAvatarColor(record.name) }}
                >
                  {getInitials(record.name)}
                </div>

                {/* Name and Message */}
                <div className="fns-support-info">
                  <span className="fns-support-name">{record.name || "Anonymous"}</span>
                  {record.message && (
                    <>
                      <span className="fns-support-sep">|</span>
                      <span className="fns-support-msg">{record.message}</span>
                    </>
                  )}
                </div>

                {/* Amount */}
                <div className="fns-support-amount-pill">
                  {record.amount} <span className="fns-support-unit">{record.unit}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="fns-support-pager">
            <div className="fns-support-pager-controls">
              <button
                disabled={pager.page <= 1 || loading}
                onClick={() => { void fetchRecords(pager.page - 1); }}
              >
                <LucideIcon icon="chevron-left" size={14} />
              </button>
              <span>{pager.page}</span>
              <button
                disabled={pager.page * pager.pageSize >= pager.totalRows || loading}
                onClick={() => { void fetchRecords(pager.page + 1); }}
              >
                <LucideIcon icon="chevron-right" size={14} />
              </button>
            </div>
          </div>
          <div className="fns-support-desc" dangerouslySetInnerHTML={{ __html: $("setting.support.thanks") }} />
          {hoverTooltip && createPortal(
            <div
              className="fns-fast-tooltip"
              style={hoverTooltip.isMobile ? {
                left: '50%',
                top: hoverTooltip.y + 40,
                transform: 'translateX(-50%)',
                maxWidth: '90vw',
                width: 'max-content'
              } : {
                left: hoverTooltip.x + 15,
                top: hoverTooltip.y + 15
              }}
            >
              {hoverTooltip.text}
            </div>,
            activeDocument.body
          )}
          {/* Supporter detail modal with premium design / 拥有高级精致设计的支持者留言详情模态框 */}
          {selectedRecord && createPortal(
            <div
              className="fns-supporter-modal-backdrop"
              onClick={() => setSelectedRecord(null)}
            >
              <div
                className="fns-supporter-modal"
                onClick={(e) => e.stopPropagation()}
              >
                <div
                  className="fns-supporter-modal-close"
                  onClick={() => setSelectedRecord(null)}
                >
                  ✕
                </div>
                <div className="fns-supporter-modal-header">
                  <div
                    className="fns-supporter-modal-avatar"
                    style={{ backgroundColor: getAvatarColor(selectedRecord.name) }}
                  >
                    {getInitials(selectedRecord.name)}
                  </div>
                  <div className="fns-supporter-modal-info">
                    <div className="fns-supporter-modal-name">
                      {selectedRecord.name || "Anonymous"}
                    </div>
                    <div className="fns-supporter-modal-amount">
                      {selectedRecord.amount}
                      <span className="fns-supporter-modal-unit">
                        {selectedRecord.unit}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="fns-supporter-modal-body">
                  <div className="fns-supporter-modal-label">
                    {$("setting.support.message_label")}
                  </div>
                  <div className={`fns-supporter-modal-text ${!selectedRecord.message ? 'is-empty' : ''}`}>
                    {selectedRecord.message || $("setting.support.no_message")}
                  </div>
                </div>
                <div className="fns-supporter-modal-footer">
                  <button
                    className="fns-supporter-modal-btn"
                    onClick={() => setSelectedRecord(null)}
                  >
                    {$("ui.button.confirm")}
                  </button>
                </div>
              </div>
            </div>,
            activeDocument.body
          )}
        </>
      )}
    </>
  );
};



export const SupportView = ({ plugin }: { plugin: FastSync }) => {
  return (
    <div className="fns-support-view-wrapper fns-supporters-list-card">
      <div className="fns-support-header-desc">
        {$("setting.support.desc")}
      </div>

      <div className="fns-support-cards-container">
        {/* Ko-fi Card */}
        <div className="fns-support-card fns-kofi-card">
          <div className="fns-support-card-header">
            <span className="fns-support-card-icon">☕</span>
            <span className="fns-support-card-title">{$("setting.support.kofi")}</span>
          </div>
          <div className="fns-support-card-body">
            <a href="https://ko-fi.com/haierkeys" target="_blank" rel="noreferrer" className="fns-support-link">
              <img src={KofiImage} className="fns-support-img-kofi" alt="Ko-fi" />
            </a>
          </div>
        </div>

        {/* WeChat Pay Card */}
        <div className="fns-support-card fns-wechat-card">
          <div className="fns-support-card-header">
            <span className="fns-support-card-icon">🧧</span>
            <span className="fns-support-card-title">{$("setting.support.wechat")}</span>
          </div>
          <div className="fns-support-card-body">
            <div className="fns-wechat-qr-wrapper">
              <img src={WXImage} className="fns-support-img-wechat" alt="WeChat Pay" />
            </div>
          </div>
        </div>
      </div>

      {/* Supporters List Section */}
      <div className="fns-supporters-list-content">
        <SupportList plugin={plugin} />
      </div>
    </div>
  )
}
