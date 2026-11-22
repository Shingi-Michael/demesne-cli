/// Something broke, said beside the project (pass 260 A). When CI on main or
/// a check starts failing while you work, a pill arrives in the right seat,
/// at the foot of the cards that show this project's branch and changes: the
/// news is the project's, so it shows with the project. The line on Home and
/// the top bar's word stay where they are; the pill is only the moment.
///
/// Read more: https://lawsofux.com/law-of-proximity/ (news sits beside what
/// it is about) and https://martinfowler.com/articles/continuousIntegration.html
/// (why a broken main is worth a word the moment it breaks).

export interface BrokeSignal { id: string; title: string; detail?: string; source?: string }
export interface BrokeSeen { workspace: string; ids: ReadonlySet<string> }

/// The words for what just broke, or null when nothing is new. `seen` is what
/// was failing at the last look (null on the first one, when nothing is news
/// yet); another project's failures are not news either.
export function brokeNews(seen: BrokeSeen | null, workspace: string, signals: readonly BrokeSignal[]): string | null {
  if (!seen || seen.workspace !== workspace) return null;
  const fresh = signals.filter((signal) => !seen.ids.has(signal.id));
  if (!fresh.length) return null;
  if (fresh.length > 1) return `${fresh.length} things broke`;
  const first = fresh[0]!, ci = /CI failure on (\S+)/.exec(first.title);
  return ci ? `CI failed on ${ci[1]}` : first.source === "checks" ? "A check is failing" : first.title;
}

export const brokeSeen = (workspace: string, signals: readonly BrokeSignal[]): BrokeSeen => ({ workspace, ids: new Set(signals.map((signal) => signal.id)) });
