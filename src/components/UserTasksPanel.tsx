// Inline panel listing tasks the user has dispatched this meeting.
//
// Data flow: meeting-store keeps every spawned worker in `state.workers`. Each
// non-talker worker IS a task the user asked for — the talker received the
// utterance, then either called delegate_task or plan_meeting which spawned
// the worker. So "tasks the user requested" = workers minus the talker.
//
// Rendered in the gallery detail area (same slot as ClaudeWorkspace) when the
// user clicks their own participant tile — replaces the old modal so the UX
// matches clicking any other participant.

import type { WorkerState } from '../lib/meeting-store';
import type { WorkerStatus } from '../types';

interface UserTasksPanelProps {
  workers: WorkerState[];
}

interface TaskRow {
  id: string;
  title: string;
  status: WorkerStatus | 'idle';
  owner: string;
  detail: string;
}

const STATUS_LABEL: Record<TaskRow['status'], string> = {
  idle: 'Idle',
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

const STATUS_TONE: Record<TaskRow['status'], string> = {
  idle: 'task-status-idle',
  pending: 'task-status-pending',
  running: 'task-status-running',
  done: 'task-status-done',
  failed: 'task-status-failed',
};

function buildRows(workers: WorkerState[]): TaskRow[] {
  return workers
    .filter((w) => w.role !== 'talker')
    .map((w) => ({
      id: w.id,
      title: w.title || w.id,
      status: w.status,
      owner: w.id,
      detail: w.summary || w.lastText || '',
    }));
}

export function UserTasksPanel({ workers }: UserTasksPanelProps) {
  const rows = buildRows(workers);

  return (
    <div className="user-tasks-inline" role="region" aria-label="Your tasks this meeting">
      <div className="user-tasks-head">
        <div className="user-tasks-title-main">你这场会议派出的任务</div>
        <div className="user-tasks-subtitle">由 host 拆解后派给各 worker · 共 {rows.length} 项</div>
      </div>

      <div className="user-tasks-body">
        {rows.length === 0 ? (
          <div className="user-tasks-empty">
            <div className="user-tasks-empty-title">尚无任务派发</div>
            <div className="user-tasks-empty-sub">
              Host 还在处理你的请求。说一个具体诉求，他就会拆成 worker 派出去。
            </div>
          </div>
        ) : (
          <table className="user-tasks-table">
            <thead>
              <tr>
                <th className="user-tasks-col-title">任务</th>
                <th className="user-tasks-col-status">状态</th>
                <th className="user-tasks-col-owner">负责人</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="user-tasks-col-title">
                    <div className="user-tasks-title">{row.title}</div>
                    {row.detail && (
                      <div className="user-tasks-detail" title={row.detail}>
                        {row.detail}
                      </div>
                    )}
                  </td>
                  <td className="user-tasks-col-status">
                    <span className={`user-tasks-pill ${STATUS_TONE[row.status]}`}>
                      {STATUS_LABEL[row.status]}
                    </span>
                  </td>
                  <td className="user-tasks-col-owner">
                    <span className="user-tasks-owner">{row.owner}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
