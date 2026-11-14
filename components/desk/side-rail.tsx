import { useCallback, useEffect, useState } from 'react'
import { Archive, Brain, Check, Loader2, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import type { AgentActionView } from '@/lib/agent/actions'
import type { AgentMemoryView, MemoryScope } from '@/lib/agent/memory'
import type { AgentProjectView } from '@/lib/agent/projects'
import { deskApi } from './api'
import { EmptyHint } from './ui'

const ACTION_LABEL: Record<AgentActionView['type'], string> = {
  watch_event: '关注事件',
  create_task: '创建任务',
  pin_project: '加入项目',
  save_memory: '保存记忆',
}

const SCOPE_LABEL: Record<MemoryScope, string> = {
  user: '用户偏好',
  project: '项目',
  industry: '行业',
  symbol: '个股',
}

// 侧栏没有项目选择器，project 记忆必然因缺 projectId 被拒，只提供能直接创建的 scope。
const CREATABLE_SCOPES: MemoryScope[] = ['user', 'industry', 'symbol']

function actionSummary(action: AgentActionView): string {
  const payload = action.payload
  switch (action.type) {
    case 'watch_event':
      return [payload.title, payload.code, payload.eventId].filter(Boolean).map(String).join(' · ') || '关注项'
    case 'create_task':
      return `${String(payload.type || '任务')}${payload.params && Object.keys(payload.params).length ? `（${Object.keys(payload.params).join(', ')}）` : ''}`
    case 'pin_project':
      return `${String(payload.kind || '')} ${String(payload.refId || '')}`.trim()
    case 'save_memory':
      return `${String(payload.key || '')}：${String(payload.value || '').slice(0, 60)}`
    default:
      return action.id
  }
}

export function SideRail({ onChanged }: { onChanged?: () => void }) {
  const [tab, setTab] = useState('actions')
  const [actions, setActions] = useState<AgentActionView[]>([])
  const [projects, setProjects] = useState<AgentProjectView[]>([])
  const [memories, setMemories] = useState<AgentMemoryView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const [projectName, setProjectName] = useState('')
  const [projectThesis, setProjectThesis] = useState('')
  const [memoryScope, setMemoryScope] = useState<MemoryScope>('user')
  const [memoryKey, setMemoryKey] = useState('')
  const [memoryValue, setMemoryValue] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [actionData, projectData, memoryData] = await Promise.all([
        deskApi<{ actions: AgentActionView[] }>('/api/agent-actions?status=proposed&limit=20'),
        deskApi<{ projects: AgentProjectView[] }>('/api/agent-projects?status=active&limit=20'),
        deskApi<{ memories: AgentMemoryView[] }>('/api/agent-memory?limit=20'),
      ])
      setActions(actionData.actions)
      setProjects(projectData.projects)
      setMemories(memoryData.memories)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const decide = async (action: AgentActionView, decision: 'confirm' | 'reject') => {
    setBusy(action.id)
    setError('')
    try {
      const data = await deskApi<{ action: AgentActionView }>('/api/agent-actions', {
        method: 'PATCH',
        body: JSON.stringify({ id: action.id, decision }),
      })
      setActions((prev) => prev.filter((item) => item.id !== action.id))
      if (decision === 'confirm') {
        // 接口 200 也可能是执行失败/已过期，必须看动作最终状态再报成功。
        if (data.action.status === 'confirmed') onChanged?.()
        else setError(data.action.errorMessage || (data.action.status === 'expired' ? '动作已过期，请重新发起。' : '动作执行失败，请重试。'))
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  const createProject = async () => {
    const name = projectName.trim()
    if (!name) return
    setBusy('project')
    setError('')
    try {
      const data = await deskApi<{ project: AgentProjectView }>('/api/agent-projects', {
        method: 'POST',
        body: JSON.stringify({ name, thesis: projectThesis.trim() || undefined }),
      })
      setProjects((prev) => [data.project, ...prev])
      setProjectName('')
      setProjectThesis('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  const archiveProject = async (project: AgentProjectView) => {
    setBusy(project.id)
    try {
      await deskApi('/api/agent-projects', {
        method: 'DELETE',
        body: JSON.stringify({ id: project.id }),
      })
      setProjects((prev) => prev.filter((item) => item.id !== project.id))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  const saveMemory = async () => {
    const key = memoryKey.trim()
    const value = memoryValue.trim()
    if (key.length < 2 || !value) {
      setError('记忆键至少 2 个字，内容不能为空')
      return
    }
    setBusy('memory')
    setError('')
    try {
      const data = await deskApi<{ memory: AgentMemoryView }>('/api/agent-memory', {
        method: 'POST',
        body: JSON.stringify({ scope: memoryScope, key, value }),
      })
      setMemories((prev) => [data.memory, ...prev.filter((item) => item.id !== data.memory.id)])
      setMemoryKey('')
      setMemoryValue('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  const removeMemory = async (memory: AgentMemoryView) => {
    setBusy(memory.id)
    try {
      await deskApi(`/api/agent-memory?id=${encodeURIComponent(memory.id)}`, { method: 'DELETE' })
      setMemories((prev) => prev.filter((item) => item.id !== memory.id))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <Card className="flex min-h-[360px] flex-col gap-0 overflow-hidden py-0 xl:min-h-0">
      <CardHeader className="relative flex shrink-0 flex-row items-center gap-2 px-4 py-2.5 after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border/60 after:content-['']">
        <ShieldCheck className="size-4 text-muted-foreground" />
        <h2 className="text-[13px] font-semibold tracking-tight">研究台</h2>
        <span className="truncate text-[11px] text-muted-foreground">动作 / 项目 / 记忆</span>
      </CardHeader>
      <CardContent className="min-h-0 p-0 xl:flex-1">
        <Tabs value={tab} onValueChange={(value) => setTab(String(value))} className="h-full gap-0">
          <div className="px-3 py-2.5">
            <TabsList className="w-full">
              <TabsTrigger value="actions" className="flex-1">动作·{actions.length}</TabsTrigger>
              <TabsTrigger value="projects" className="flex-1">项目·{projects.length}</TabsTrigger>
              <TabsTrigger value="memory" className="flex-1">记忆·{memories.length}</TabsTrigger>
            </TabsList>
          </div>

          <div className="min-h-0 xl:flex-1 xl:overflow-y-auto">
            {error && (
              <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</div>
            )}
            {loading && (
              <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />读取研究台
              </div>
            )}

            <TabsContent value="actions" className="p-0">
              {!loading && actions.length === 0 && (
                <EmptyHint>没有待确认动作。研究助手提议的关注、任务、记忆会先出现在这里，确认后才执行。</EmptyHint>
              )}
              {actions.map((action) => (
                <div key={action.id} className="relative px-4 py-3 after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border/50 after:content-[''] last:after:hidden">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{ACTION_LABEL[action.type]}</Badge>
                    <span className="text-[10px] text-muted-foreground">{action.createdAt.slice(5, 16).replace('T', ' ')}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs leading-5">{actionSummary(action)}</p>
                  {action.sessionId && <p className="mt-0.5 text-[10px] text-muted-foreground">来自会话 {action.sessionId}</p>}
                  <div className="mt-2 flex gap-1.5">
                    <Button size="xs" disabled={busy === action.id} onClick={() => void decide(action, 'confirm')}>
                      <Check className="size-3.5" />确认
                    </Button>
                    <Button size="xs" variant="ghost" disabled={busy === action.id} onClick={() => void decide(action, 'reject')}>
                      <X className="size-3.5" />忽略
                    </Button>
                  </div>
                </div>
              ))}
            </TabsContent>

            <TabsContent value="projects" className="p-0">
              <div className="space-y-2 bg-muted/20 px-4 py-3">
                <Input
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="新研究项目名称"
                  maxLength={100}
                />
                <Textarea
                  value={projectThesis}
                  onChange={(event) => setProjectThesis(event.target.value)}
                  placeholder="一句话论点（可选）"
                  className="min-h-14 text-xs"
                  maxLength={2000}
                />
                <Button size="xs" disabled={busy === 'project' || !projectName.trim()} onClick={() => void createProject()}>
                  {busy === 'project' ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}新建项目
                </Button>
              </div>
              {!loading && projects.length === 0 && <EmptyHint>还没有研究项目。把行业、个股和证据放进同一个项目，研究助手会带着这组上下文回答。</EmptyHint>}
              {projects.map((project) => (
                <div key={project.id} className="group relative px-4 py-3 after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border/50 after:content-[''] last:after:hidden">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold tracking-tight">{project.name}</p>
                      {project.thesis && <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{project.thesis}</p>}
                    </div>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      title="归档项目"
                      disabled={busy === project.id}
                      onClick={() => void archiveProject(project)}
                    >
                      <Archive className="size-3.5" />
                    </Button>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {project.industries.map((industry) => (
                      <Badge key={industry} variant="secondary" className="h-5 px-1.5 text-[10px]">{industry}</Badge>
                    ))}
                    {project.symbols.map((symbol) => (
                      <Badge key={symbol} variant="outline" className="h-5 px-1.5 font-mono text-[10px]">{symbol}</Badge>
                    ))}
                    <span className="text-[10px] text-muted-foreground">{project.items.length} 条关联</span>
                  </div>
                </div>
              ))}
            </TabsContent>

            <TabsContent value="memory" className="p-0">
              <div className="space-y-2 bg-muted/20 px-4 py-3">
                <div className="flex gap-2">
                  <select
                    value={memoryScope}
                    onChange={(event) => setMemoryScope(event.target.value as MemoryScope)}
                    className="h-9 shrink-0 rounded-lg border border-border bg-transparent px-2 text-xs shadow-sm focus-visible:border-ring focus-visible:outline-none"
                  >
                    {CREATABLE_SCOPES.map((scope) => (
                      <option key={scope} value={scope}>{SCOPE_LABEL[scope]}</option>
                    ))}
                  </select>
                  <Input
                    value={memoryKey}
                    onChange={(event) => setMemoryKey(event.target.value)}
                    placeholder="记忆键，如 风险偏好"
                    maxLength={80}
                  />
                </div>
                <Textarea
                  value={memoryValue}
                  onChange={(event) => setMemoryValue(event.target.value)}
                  placeholder="要记住的事实或约束"
                  className="min-h-14 text-xs"
                  maxLength={2000}
                />
                <Button
                  size="xs"
                  disabled={busy === 'memory' || !memoryKey.trim() || !memoryValue.trim()}
                  onClick={() => void saveMemory()}
                >
                  {busy === 'memory' ? <Loader2 className="size-3.5 animate-spin" /> : <Brain className="size-3.5" />}记住
                </Button>
              </div>
              {!loading && memories.length === 0 && <EmptyHint>还没有长期记忆。研究助手会在后续对话中带上这些偏好与结论。</EmptyHint>}
              {memories.map((memory) => (
                <div key={memory.id} className="group relative flex items-start gap-2 px-4 py-2.5 after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border/50 after:content-[''] last:after:hidden">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{SCOPE_LABEL[memory.scope]}</Badge>
                      <span className="truncate text-xs font-medium">{memory.key}</span>
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">{memory.confidence.toFixed(2)}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{memory.value}</p>
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title="删除记忆"
                    disabled={busy === memory.id}
                    onClick={() => void removeMemory(memory)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </TabsContent>
          </div>
        </Tabs>
      </CardContent>
    </Card>
  )
}
