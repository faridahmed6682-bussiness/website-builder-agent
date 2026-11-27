// Multi-agent team status strip — Planner → Coder → Reviewer → Tester.
// The server emits `agent_status` SSE events (role + working/done/failed);
// this strip shows each agent's live status while a build runs.
import React from 'react';

export interface AgentStatus {
  role: 'planner' | 'coder' | 'reviewer' | 'tester';
  status: 'working' | 'done' | 'failed';
  detail?: string;
}

const ROLES: Array<{ role: AgentStatus['role']; label: string }> = [
  { role: 'planner', label: 'Planner' },
  { role: 'coder', label: 'Coder' },
  { role: 'reviewer', label: 'Reviewer' },
  { role: 'tester', label: 'Tester' },
];

export const TeamStatus: React.FC<{ statuses: AgentStatus[] }> = ({ statuses }) => {
  if (!statuses.length) return null;
  const byRole = new Map(statuses.map((s) => [s.role, s]));
  return (
    <div className="flex flex-wrap items-center gap-2 max-w-4xl mx-auto w-full px-1 py-1">
      {ROLES.map(({ role, label }) => {
        const s = byRole.get(role);
        const dot = !s
          ? 'bg-slate-600'
          : s.status === 'working'
            ? 'bg-sky-400 animate-pulse'
            : s.status === 'done'
              ? 'bg-emerald-400'
              : 'bg-rose-400';
        const text = !s ? 'text-slate-500' : s.status === 'working' ? 'text-sky-300' : s.status === 'done' ? 'text-emerald-300' : 'text-rose-300';
        return (
          <span key={role} className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${text}`} title={s?.detail || label}>
            <span className={`w-2 h-2 rounded-full ${dot}`} />
            {label}
            {s?.status === 'working' ? '…' : s?.status === 'done' ? ' ✓' : s?.status === 'failed' ? ' ✕' : ''}
          </span>
        );
      })}
    </div>
  );
};
