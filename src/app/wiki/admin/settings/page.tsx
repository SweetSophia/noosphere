import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getRecallSettingsFromDB } from "@/lib/memory/api/settings";
import { Breadcrumbs } from "@/components/wiki/Breadcrumbs";
import { PageHeader } from "@/components/wiki/PageHeader";
import { updateSettingsAction } from "./actions";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Recall Settings",
  description: "Configure memory recall behavior, deduplication, and conflict resolution.",
};

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    redirect("/wiki/login");
  }
  if (session.user.role !== "ADMIN") {
    redirect("/wiki");
  }

  const cookieStore = await cookies();
  const flash = cookieStore.get("settings_flash")?.value ?? null;

  const settings = await getRecallSettingsFromDB();

  return (
    <div className="wiki-content">
      <Breadcrumbs
        items={[
          { label: "Noosphere", href: "/wiki" },
          { label: "Admin" },
          { label: "Recall Settings" },
        ]}
      />

      <PageHeader
        eyebrow="Admin Console"
        title="Recall Settings"
        description="Configure how the memory system retrieves, deduplicates, and resolves conflicts across providers."
      />

      {flash && (
        <div className="alert alert-success" role="status">
          {flash}
        </div>
      )}

      <form action={updateSettingsAction}>
        {/* ── Auto-Recall ─────────────────────────────────── */}
        <section className="admin-card">
          <div className="section-header">
            <div className="section-header-copy">
              <p className="page-eyebrow">Injection</p>
              <h2 className="section-title">Auto-Recall</h2>
              <p className="section-subtitle">
                Automatic memory retrieval before each prompt build.
              </p>
            </div>
          </div>
          <div className="admin-form-grid">
            <div className="form-group form-group-wide">
              <label className="form-label" htmlFor="autoRecallEnabled">
                Enable Auto-Recall
              </label>
              <div className="form-hint-row">
                <input
                  type="checkbox"
                  id="autoRecallEnabled"
                  name="autoRecallEnabled"
                  value="true"
                  defaultChecked={settings.autoRecallEnabled}
                />
                <span className="form-hint">
                  When enabled, relevant memories are injected into the system prompt automatically.
                </span>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="maxInjectedMemories">
                Max Memories Per Cycle
              </label>
              <input
                type="number"
                id="maxInjectedMemories"
                name="maxInjectedMemories"
                className="form-input"
                min={1}
                max={100}
                defaultValue={settings.maxInjectedMemories}
              />
              <span className="form-hint">1–100</span>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="maxInjectedTokens">
                Max Tokens Per Cycle
              </label>
              <input
                type="number"
                id="maxInjectedTokens"
                name="maxInjectedTokens"
                className="form-input"
                min={100}
                max={10000}
                step={100}
                defaultValue={settings.maxInjectedTokens}
              />
              <span className="form-hint">100–10,000</span>
            </div>
          </div>
        </section>

        {/* ── Output Control ──────────────────────────────── */}
        <section className="admin-card">
          <div className="section-header">
            <div className="section-header-copy">
              <p className="page-eyebrow">Output</p>
              <h2 className="section-title">Recall Output</h2>
              <p className="section-subtitle">
                Control verbosity and content preference.
              </p>
            </div>
          </div>
          <div className="admin-form-grid">
            <div className="form-group">
              <label className="form-label" htmlFor="recallVerbosity">
                Verbosity
              </label>
              <select
                id="recallVerbosity"
                name="recallVerbosity"
                className="form-select"
                defaultValue={settings.recallVerbosity}
              >
                <option value="minimal">Minimal — one line per memory</option>
                <option value="standard">Standard — brief summary</option>
                <option value="detailed">Detailed — full content</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="summaryFirst">Prefer Summaries</label>
              <div className="form-hint-row">
                <input
                  type="checkbox"
                  id="summaryFirst"
                  name="summaryFirst"
                  value="true"
                  defaultChecked={settings.summaryFirst}
                />
                <span className="form-hint">
                  When available, use summary content instead of full article text.
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Deduplication ───────────────────────────────── */}
        <section className="admin-card">
          <div className="section-header">
            <div className="section-header-copy">
              <p className="page-eyebrow">Dedup</p>
              <h2 className="section-title">Deduplication</h2>
              <p className="section-subtitle">
                How to handle duplicate memories across providers.
              </p>
            </div>
          </div>
          <div className="admin-form-grid">
            <div className="form-group form-group-wide">
              <label className="form-label" htmlFor="deduplicationStrategy">
                Strategy
              </label>
              <select
                id="deduplicationStrategy"
                name="deduplicationStrategy"
                className="form-select"
                defaultValue={settings.deduplicationStrategy}
              >
                <option value="best-score">Best Score — keep highest-ranked result</option>
                <option value="provider-priority">Provider Priority — prefer configured order</option>
                <option value="most-recent">Most Recent — newest timestamp wins</option>
              </select>
            </div>
          </div>
        </section>

        {/* ── Conflict Resolution ──────────────────────────── */}
        <section className="admin-card">
          <div className="section-header">
            <div className="section-header-copy">
              <p className="page-eyebrow">Conflicts</p>
              <h2 className="section-title">Conflict Resolution</h2>
              <p className="section-subtitle">
                How to handle contradictory information across providers.
              </p>
            </div>
          </div>
          <div className="admin-form-grid">
            <div className="form-group">
              <label className="form-label" htmlFor="conflictStrategy">
                Strategy
              </label>
              <select
                id="conflictStrategy"
                name="conflictStrategy"
                className="form-select"
                defaultValue={settings.conflictStrategy}
              >
                <option value="surface">Surface — show conflicts for inspection</option>
                <option value="accept-highest">Accept Highest — keep highest-scoring</option>
                <option value="accept-recent">Accept Recent — keep most recent</option>
                <option value="accept-curated">Accept Curated — prefer curated sources</option>
                <option value="suppress-low">Suppress Low — silently drop lower scores</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="conflictThreshold">
                Detection Threshold
              </label>
              <input
                type="range"
                id="conflictThreshold"
                name="conflictThreshold"
                className="form-range"
                min={0}
                max={1}
                step={0.05}
                defaultValue={settings.conflictThreshold}
              />
              <div className="form-range-labels">
                <span>Lenient</span>
                <span className="form-range-value">
                  {settings.conflictThreshold.toFixed(2)}
                </span>
                <span>Strict</span>
              </div>
              <span className="form-hint">
                Score difference required before two results are flagged as conflicting.
              </span>
            </div>
          </div>
        </section>

        {/* ── Provider Configuration ──────────────────────── */}
        <section className="admin-card">
          <div className="section-header">
            <div className="section-header-copy">
              <p className="page-eyebrow">Providers</p>
              <h2 className="section-title">Enabled Providers</h2>
              <p className="section-subtitle">
                Which memory sources are consulted during recall.
              </p>
            </div>
          </div>
          <div className="admin-form-grid">
            <div className="form-group form-group-wide">
              <label className="form-label">Providers</label>
              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    name="enabledProviders"
                    value="noosphere"
                    defaultChecked={settings.enabledProviders.includes("noosphere")}
                  />
                  <span>Noosphere</span>
                </label>
                <p className="form-hint">
                  The built-in agent-authored wiki memory source.
                </p>
              </div>
            </div>

            <div className="form-group form-group-wide">
              <label className="form-label" htmlFor="providerPriorityWeights">
                Provider Priority Weights
              </label>
              <textarea
                id="providerPriorityWeights"
                name="providerPriorityWeights"
                className="form-textarea form-textarea-code"
                rows={3}
                placeholder='{"noosphere": 1.0}'
                defaultValue={JSON.stringify(settings.providerPriorityWeights, null, 2)}
              />
              <span className="form-hint">
                JSON object mapping provider ID to weight (0.0–2.0). Higher weight = more influence in scoring.
              </span>
            </div>
          </div>
        </section>

        <div className="form-actions-bar">
          <button type="submit" className="btn btn-primary">
            Save Settings
          </button>
        </div>
      </form>

      <details className="settings-debug">
        <summary>Current settings (raw)</summary>
        <pre><code>{JSON.stringify(settings, null, 2)}</code></pre>
      </details>
    </div>
  );
}
