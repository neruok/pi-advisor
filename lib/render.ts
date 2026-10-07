import type { Theme, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { Usage } from '@earendil-works/pi-ai';
import type { Advice, Metadata, Phase } from './session.ts';
import type { Failure } from './protocol.ts';

const PREVIEW_ROWS = 8;
type Kind = 'advisor' | 'advisor_sessions' | 'advisor_close';
type Data = Advice | Failure | { ok: true; sessions: Metadata[] } | { ok: true; session: string };
const safe = (text: string): string => text.replace(/\t/g, ' ').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '');
const value = (text: unknown): string => typeof text === 'string' ? safe(text) : '?';
const label = (text: unknown): string => value(text).replace(/\n/g, ' ');
function component(lines: (width: number) => string[]): Component {
  return { render: width => width < 1 ? [] : lines(width).map(line => truncateToWidth(line, width)), invalidate() {} };
}
function usageLine(usage: Usage | undefined, complete: boolean | undefined): string {
  const tokens = usage?.totalTokens ?? 0, cost = usage?.cost?.total;
  return `${tokens} reported tokens${typeof cost === 'number' && Number.isFinite(cost) ? `, $${cost.toFixed(6)} reported cost` : ''}${complete === true ? '' : ' (incomplete: remote usage may be missing)'}`;
}
function header(data: Advice): string {
  return `Advisory • ${label(data.session)} • turn ${data.turns}`;
}
function sessionLines(entry: Metadata, expanded: boolean): string[] {
  return [
    `${label(entry.session)}${entry.busy ? ' • busy' : ''} • ${entry.turnsRemaining} turns remaining`,
    ...(expanded ? [label(entry.label), `${label(entry.model?.provider)}/${label(entry.model?.model)} • ${entry.historyBytesRemaining} history bytes remaining`, usageLine(entry.totalUsage, entry.totalUsageComplete)] : [])
  ];
}
function details(value: unknown): Data | undefined {
  if (!value || typeof value !== 'object' || !('ok' in value)) return undefined;
  const data = value as Data;
  if (data.ok === false) return data.error && typeof data.error.code === 'string' && typeof data.error.message === 'string' ? data : undefined;
  if (data.ok !== true) return undefined;
  if ('response' in data) return typeof data.response === 'string' && data.model && typeof data.session === 'string' ? data : undefined;
  if ('sessions' in data) return Array.isArray(data.sessions) ? data : undefined;
  return 'session' in data && typeof data.session === 'string' ? data : undefined;
}
function resultLines(kind: Kind, data: Data | undefined, options: ToolRenderResultOptions, theme: Theme, width: number): string[] {
  const styled = (color: 'muted' | 'error' | 'toolOutput' | 'accent', text: string) => wrapTextWithAnsi(theme.fg(color, safe(text)), width);
  if (!data) return styled('muted', 'Advisor result details unavailable.');
  if (!data.ok) {
    const lines = [theme.fg('error', safe(`${label(data.error.code)}: ${value(data.error.message)}`))];
    if (data.error.limit) lines.push(theme.fg('muted', safe(`${data.error.limit.resource}: ${data.error.limit.actual} / ${data.error.limit.maximum}`)));
    if (data.error.diagnostics) {
      const diagnostic = data.error.diagnostics;
      lines.push(theme.fg('muted', safe(`Failure phase: ${label(diagnostic.phase)} • category: ${label(diagnostic.category)}`)));
      if (diagnostic.code === 'sdk-invalid-timeout') lines.push(theme.fg('error', 'SDK timeout must be a positive integer. No exchange was committed.'));
      if (diagnostic.code === 'tool-choice-without-tools') lines.push(theme.fg('error', 'xAI rejected tool_choice without tools. No exchange was committed.'));
      if (diagnostic.httpStatus !== undefined) lines.push(theme.fg('muted', safe(`HTTP status: ${diagnostic.httpStatus}`)));
      if (diagnostic.model) lines.push(theme.fg('muted', safe(`${label(diagnostic.model.provider)}/${label(diagnostic.model.model)} • ${label(diagnostic.selectionSource)} • reasoning: ${label(diagnostic.model.reasoning ?? 'default')}`)));
    }
    lines.push(theme.fg('muted', usageLine(data.usage, data.usageComplete)));
    if (options.expanded && data.totalUsage) lines.push(theme.fg('muted', `Consultation total: ${usageLine(data.totalUsage, data.totalUsageComplete)}`));
    return lines.flatMap(line => wrapTextWithAnsi(line, width));
  }
  if (kind === 'advisor' && 'response' in data) {
    const lines = [...styled('accent', header(data)), ...styled('muted', usageLine(data.usage, data.usageComplete))];
    if (options.expanded) {
      lines.push(...styled('muted', `${label(data.model.provider)}/${label(data.model.model)}`));
      lines.push(...styled('muted', `Reasoning: ${data.model.reasoning ?? 'default (legacy provider behavior)'}`));
      lines.push(...styled('muted', `Consultation total: ${usageLine(data.totalUsage, data.totalUsageComplete)}`));
    }
    const adviceRows = styled('toolOutput', value(data.response));
    const preview = !options.expanded && adviceRows.length > PREVIEW_ROWS;
    lines.push(...(preview ? adviceRows.slice(0, PREVIEW_ROWS) : adviceRows));
    if (preview) lines.push(...styled('muted', '… Expand for full advice.'));
    return lines;
  }
  if (kind === 'advisor_sessions' && 'sessions' in data) {
    return [...styled('muted', `${data.sessions.length} active advisor consultations`), ...data.sessions.slice(0, 8).flatMap(entry => sessionLines(entry, options.expanded).flatMap(line => styled('toolOutput', line)))];
  }
  if (kind === 'advisor_close' && 'session' in data) return styled('muted', `Advisor consultation closed: ${label(data.session)}. Parent transcript remains.`);
  return styled('muted', 'Advisor result details unavailable.');
}
export function toolRenderers(kind: Kind) {
  return {
    renderCall(args: object, theme: Theme): Component {
      const session = 'session' in args ? args.session : undefined;
      return component(() => [theme.fg('toolTitle', theme.bold(kind === 'advisor'
        ? `Advisor • ${typeof session === 'string' ? `continue ${label(session)}` : 'new consultation'}`
        : kind === 'advisor_sessions' ? 'Advisor • active consultations' : `Advisor • close ${label(session)}`))]);
    },
    renderResult(result: { details?: unknown }, options: ToolRenderResultOptions, theme: Theme): Component {
      return component(width => {
        if (options.isPartial) {
          const phase = (result.details as { phase?: Phase } | undefined)?.phase;
          const text = phase === 'preparing' ? 'Advisor: preparing model…' : phase === 'waiting' ? 'Advisor: waiting for validated reply…' : 'Advisor request pending…';
          return wrapTextWithAnsi(theme.fg('muted', text), width);
        }
        return resultLines(kind, details(result.details), options, theme, width);
      });
    }
  };
}
