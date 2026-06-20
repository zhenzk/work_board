import seedData from '../seed-data.json';

const VALID_STATUSES = new Set(['todo', 'doing', 'verify', 'done']);
const VALID_PRIORITIES = new Set(['low', 'medium', 'high']);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const DEFAULT_ADMIN_USER = 'admin';
const DEFAULT_ADMIN_DISPLAY_NAME = '管理员';
const PASSWORD_ITERATIONS = 100000;
const SEED_DATA = seedData;
let seedChecked = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (url.pathname === '/api/health') return await health(env);
      await ensureSeedData(env);
      const handler = routeRequest(request, url);
      if (!handler) return json({ error: '接口不存在' }, 404);
      return await handler(request, env, url);
    } catch (err) {
      if (err.status) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: '服务器内部错误' }, 500);
    }
  }
};

function routeRequest(request, url) {
  const { method } = request;
  const path = url.pathname;

  if (method === 'POST' && path === '/api/auth/login') return login;
  if (method === 'POST' && path === '/api/auth/guest') return guest;
  if (method === 'GET' && path === '/api/auth/me') return me;
  if (method === 'GET' && path === '/api/auth/users') return listUsers;
  if (method === 'POST' && path === '/api/auth/users') return createUser;
  if (method === 'PUT' && /^\/api\/auth\/users\/\d+$/.test(path)) return updateUser;
  if (method === 'DELETE' && /^\/api\/auth\/users\/\d+$/.test(path)) return deleteUser;

  if (method === 'GET' && path === '/api/projects') return listProjects;
  if (method === 'POST' && path === '/api/projects') return createProject;
  if (method === 'PUT' && /^\/api\/projects\/\d+$/.test(path)) return updateProject;
  if (method === 'DELETE' && /^\/api\/projects\/\d+$/.test(path)) return deleteProject;
  if (method === 'GET' && /^\/api\/projects\/\d+\/members$/.test(path)) return listProjectMembers;
  if (method === 'POST' && /^\/api\/projects\/\d+\/members$/.test(path)) return addProjectMember;
  if (method === 'DELETE' && /^\/api\/projects\/\d+\/members\/\d+$/.test(path)) return removeProjectMember;

  if (method === 'GET' && path === '/api/tasks') return listTasks;
  if (method === 'POST' && path === '/api/tasks') return createTask;
  if (method === 'POST' && path === '/api/tasks/reorder') return reorderTasks;
  if (method === 'PUT' && /^\/api\/tasks\/\d+$/.test(path)) return updateTask;
  if (method === 'DELETE' && /^\/api\/tasks\/\d+$/.test(path)) return deleteTask;

  if (method === 'GET' && path === '/api/stats') return stats;
  return null;
}

async function requireUser(request, env) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Bearer ')) throw httpError(401, '未登录，请先登录');
  const payload = await verifyToken(header.slice(7), env);
  if (!payload) throw httpError(401, '登录已过期，请重新登录');
  return payload;
}

async function requireAdmin(request, env) {
  const user = await requireUser(request, env);
  if (user.role !== 'admin') throw httpError(403, '仅管理员可执行此操作');
  return user;
}

async function login(request, env) {
  const body = await readJson(request);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return json({ error: '请输入用户名和密码' }, 400);
  if (username.length > 50 || password.length > 100) return json({ error: '输入过长' }, 400);

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const limited = await checkLoginLimit(env, ip);
  if (limited) return json({ error: `登录尝试过多，请${limited}分钟后重试` }, 429);

  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user || !(await verifyPassword(password, user.password))) {
    await recordFailedLogin(env, ip);
    return json({ error: '用户名或密码错误' }, 401);
  }

  await clearFailedLogin(env, ip);
  const token = await signToken(user, env);
  return json({ token, user: pickUser(user) });
}

async function guest(_request, env) {
  const user = { id: 0, username: 'guest', display_name: '游客', role: 'guest', avatar: 'G' };
  const token = await signToken(user, env);
  return json({ token, user });
}

async function me(request, env) {
  const user = await requireUser(request, env);
  if (user.role === 'guest') return json(user);
  const row = await env.DB.prepare(
    'SELECT id, username, display_name, role, avatar, created_at FROM users WHERE id = ?'
  ).bind(user.id).first();
  if (!row) return json({ error: '用户不存在' }, 404);
  return json(row);
}

async function createUser(request, env) {
  await requireAdmin(request, env);
  const body = await readJson(request);
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const displayName = String(body.display_name || '').trim();
  const role = body.role || 'member';

  if (!username || !password || !displayName) return json({ error: '请填写完整信息' }, 400);
  if (password.length < 4) return json({ error: '密码至少4位' }, 400);
  if (username.length > 50) return json({ error: '用户名过长' }, 400);
  if (displayName.length > 50) return json({ error: '显示名称过长' }, 400);
  if (!['admin', 'member'].includes(role)) return json({ error: '无效的角色类型' }, 400);

  const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (exists) return json({ error: '用户名已存在' }, 409);

  const hashed = await hashPassword(password);
  const avatar = String(body.avatar || displayName.charAt(0));
  const result = await env.DB.prepare(
    'INSERT INTO users (username, password, display_name, role, avatar) VALUES (?, ?, ?, ?, ?)'
  ).bind(username, hashed, displayName, role, avatar).run();

  const userId = result.meta.last_row_id;
  await replaceProjectMemberships(env, userId, body.project_ids);
  return json({ id: userId, username, display_name: displayName, role });
}

async function listUsers(request, env) {
  await requireAdmin(request, env);
  const users = await all(env, 'SELECT id, username, display_name, role, avatar, created_at FROM users ORDER BY id');
  const memberships = await all(env, 'SELECT user_id, project_id FROM project_members');
  const map = new Map();
  for (const item of memberships) {
    if (!map.has(item.user_id)) map.set(item.user_id, []);
    map.get(item.user_id).push(item.project_id);
  }
  return json(users.map((u) => ({ ...u, project_ids: map.get(u.id) || [] })));
}

async function updateUser(request, env, url) {
  await requireAdmin(request, env);
  const id = Number(url.pathname.split('/').pop());
  const body = await readJson(request);
  const displayName = String(body.display_name || '').trim();
  const role = body.role || 'member';
  if (!displayName) return json({ error: '显示名称不能为空' }, 400);
  if (!['admin', 'member'].includes(role)) return json({ error: '无效的角色类型' }, 400);

  const avatar = String(body.avatar || displayName.charAt(0));
  if (body.password) {
    if (String(body.password).length < 4) return json({ error: '密码至少4位' }, 400);
    const hashed = await hashPassword(String(body.password));
    await env.DB.prepare('UPDATE users SET display_name = ?, role = ?, password = ?, avatar = ? WHERE id = ?')
      .bind(displayName, role, hashed, avatar, id)
      .run();
  } else {
    await env.DB.prepare('UPDATE users SET display_name = ?, role = ?, avatar = ? WHERE id = ?')
      .bind(displayName, role, avatar, id)
      .run();
  }

  if (Array.isArray(body.project_ids)) await replaceProjectMemberships(env, id, body.project_ids);
  return json({ success: true });
}

async function deleteUser(request, env, url) {
  const current = await requireAdmin(request, env);
  const id = Number(url.pathname.split('/').pop());
  if (id === Number(current.id)) return json({ error: '不能删除自己' }, 400);

  await env.DB.batch([
    env.DB.prepare('UPDATE tasks SET assigned_to = NULL WHERE assigned_to = ?').bind(id),
    env.DB.prepare('UPDATE tasks SET created_by = NULL WHERE created_by = ?').bind(id),
    env.DB.prepare('UPDATE projects SET created_by = NULL WHERE created_by = ?').bind(id),
    env.DB.prepare('DELETE FROM project_members WHERE user_id = ?').bind(id),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id)
  ]);
  return json({ success: true });
}

async function listProjects(request, env) {
  await requireUser(request, env);
  return json(await all(env, `
    SELECT p.*,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count,
      (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status = 'done') as done_count
    FROM projects p ORDER BY p.id
  `));
}

async function createProject(request, env) {
  const user = await requireAdmin(request, env);
  const body = await readJson(request);
  const name = String(body.name || '').trim();
  if (!name) return json({ error: '项目名称不能为空' }, 400);
  if (name.length > 100) return json({ error: '项目名称过长' }, 400);

  const result = await env.DB.prepare(`
    INSERT INTO projects (name, icon, color, description, start_date, end_date, status, priority, role, original_end_date, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    name,
    String(body.icon || ''),
    String(body.color || 'cyan'),
    String(body.description || ''),
    String(body.start_date || ''),
    String(body.end_date || ''),
    String(body.status || ''),
    String(body.project_priority || body.priority || ''),
    String(body.role || ''),
    String(body.original_end_date || ''),
    user.id
  ).run();
  const id = result.meta.last_row_id;
  await env.DB.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').bind(id, user.id).run();
  return json({ id });
}

async function updateProject(request, env, url) {
  await requireAdmin(request, env);
  const id = Number(url.pathname.split('/').pop());
  const body = await readJson(request);
  const name = String(body.name || '').trim();
  if (!name) return json({ error: '项目名称不能为空' }, 400);
  const result = await env.DB.prepare(`
    UPDATE projects SET name = ?, icon = ?, color = ?, description = ?, start_date = ?, end_date = ?,
      status = ?, priority = ?, role = ?, original_end_date = ? WHERE id = ?
  `).bind(
    name,
    String(body.icon || ''),
    String(body.color || 'cyan'),
    String(body.description || ''),
    String(body.start_date || ''),
    String(body.end_date || ''),
    String(body.status || ''),
    String(body.project_priority || body.priority || ''),
    String(body.role || ''),
    String(body.original_end_date || ''),
    id
  ).run();
  if (!result.meta.changes) return json({ error: '项目不存在' }, 404);
  return json({ success: true });
}

async function deleteProject(request, env, url) {
  await requireAdmin(request, env);
  const id = Number(url.pathname.split('/').pop());
  const project = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(id).first();
  if (!project) return json({ error: '项目不存在' }, 404);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tasks WHERE project_id = ?').bind(id),
    env.DB.prepare('DELETE FROM project_members WHERE project_id = ?').bind(id),
    env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(id)
  ]);
  return json({ success: true });
}

async function listProjectMembers(request, env, url) {
  await requireUser(request, env);
  const id = Number(url.pathname.split('/')[3]);
  return json(await all(env, `
    SELECT u.id, u.username, u.display_name, u.role, u.avatar
    FROM users u
    JOIN project_members pm ON pm.user_id = u.id
    WHERE pm.project_id = ?
  `, [id]));
}

async function addProjectMember(request, env, url) {
  await requireAdmin(request, env);
  const id = Number(url.pathname.split('/')[3]);
  const body = await readJson(request);
  if (!body.user_id) return json({ error: '用户ID不能为空' }, 400);
  await env.DB.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').bind(id, body.user_id).run();
  return json({ success: true });
}

async function removeProjectMember(request, env, url) {
  await requireAdmin(request, env);
  const parts = url.pathname.split('/');
  await env.DB.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
    .bind(Number(parts[3]), Number(parts[5]))
    .run();
  return json({ success: true });
}

async function listTasks(request, env) {
  await requireUser(request, env);
  return json(await all(env, `
    SELECT t.*, u.display_name as assignee_name, u.avatar as assignee_avatar,
           cu.display_name as creator_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assigned_to
    LEFT JOIN users cu ON cu.id = t.created_by
    ORDER BY t.sort_order ASC, CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 END, t.id
  `));
}

async function createTask(request, env) {
  const user = await requireUser(request, env);
  if (user.role === 'guest') return json({ error: '游客模式仅可查看' }, 403);
  const body = await readJson(request);
  const title = String(body.title || '').trim();
  if (!title) return json({ error: '任务名称不能为空' }, 400);
  if (title.length > 200) return json({ error: '任务名称过长' }, 400);
  if (!body.deadline) return json({ error: '截止日期不能为空' }, 400);
  if (!body.project_id) return json({ error: '所属项目不能为空' }, 400);
  if (body.status && !VALID_STATUSES.has(body.status)) return json({ error: '无效的状态值' }, 400);
  if (body.priority && !VALID_PRIORITIES.has(body.priority)) return json({ error: '无效的优先级值' }, 400);

  const project = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(body.project_id).first();
  if (!project) return json({ error: '项目不存在' }, 404);
  if (user.role !== 'admin') {
    const member = await env.DB.prepare('SELECT id FROM project_members WHERE project_id = ? AND user_id = ?')
      .bind(body.project_id, user.id)
      .first();
    if (!member) return json({ error: '你不是该项目的成员' }, 403);
  }

  const result = await env.DB.prepare(`
    INSERT INTO tasks (project_id, title, description, status, priority, start_date, deadline, assigned_to, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    body.project_id,
    title,
    String(body.description || ''),
    body.status || 'todo',
    body.priority || 'medium',
    String(body.start_date || ''),
    String(body.deadline),
    body.assigned_to || null,
    user.id
  ).run();
  return json({ id: result.meta.last_row_id });
}

async function updateTask(request, env, url) {
  const user = await requireUser(request, env);
  if (user.role === 'guest') return json({ error: '游客模式仅可查看' }, 403);
  const id = Number(url.pathname.split('/').pop());
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  if (!task) return json({ error: '任务不存在' }, 404);
  if (task.status === 'done' && user.role !== 'admin') return json({ error: '已完成的任务不能修改' }, 403);
  if (user.role !== 'admin' && task.created_by !== user.id) return json({ error: '只能修改自己创建的任务' }, 403);

  const body = await readJson(request);
  if (body.status && !VALID_STATUSES.has(body.status)) return json({ error: '无效的状态值' }, 400);
  if (body.priority && !VALID_PRIORITIES.has(body.priority)) return json({ error: '无效的优先级值' }, 400);
  if (body.title !== undefined && !String(body.title).trim()) return json({ error: '任务名称不能为空' }, 400);

  const isExtended = body.deadline && body.deadline !== task.deadline;
  const originalDeadline = isExtended ? task.deadline : (body.original_deadline || task.original_deadline || '');
  await env.DB.prepare(`
    UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, start_date = ?, deadline = ?,
      assigned_to = ?, extended = ?, extended_reason = ?, original_deadline = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).bind(
    body.title !== undefined ? String(body.title).trim() : task.title,
    body.description !== undefined ? String(body.description) : task.description,
    body.status !== undefined ? body.status : task.status,
    body.priority !== undefined ? body.priority : task.priority,
    body.start_date !== undefined ? String(body.start_date) : task.start_date,
    body.deadline !== undefined ? String(body.deadline) : task.deadline,
    body.assigned_to !== undefined ? body.assigned_to : task.assigned_to,
    isExtended ? 1 : (body.extended !== undefined ? body.extended : task.extended),
    body.extended_reason !== undefined ? String(body.extended_reason) : task.extended_reason,
    originalDeadline,
    id
  ).run();
  return json({ success: true });
}

async function deleteTask(request, env, url) {
  await requireAdmin(request, env);
  const id = Number(url.pathname.split('/').pop());
  const result = await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return json({ error: '任务不存在' }, 404);
  return json({ success: true });
}

async function reorderTasks(request, env) {
  const user = await requireUser(request, env);
  if (user.role === 'guest') return json({ error: '游客模式仅可查看' }, 403);
  const body = await readJson(request);
  if (!Array.isArray(body.items) || body.items.length === 0) return json({ error: '无效数据' }, 400);
  if (body.items.length > 200) return json({ error: '批量操作数量过多' }, 400);

  const statements = [];
  for (const item of body.items) {
    if (!item.id) continue;
    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(item.id).first();
    if (!task) continue;
    if (task.status === 'done' && user.role !== 'admin') continue;
    if (user.role !== 'admin' && task.created_by !== user.id) continue;
    const status = item.status !== undefined ? item.status : task.status;
    const priority = item.priority !== undefined ? item.priority : task.priority;
    if (!VALID_STATUSES.has(status) || !VALID_PRIORITIES.has(priority)) continue;
    statements.push(env.DB.prepare(`
      UPDATE tasks SET status = ?, priority = ?, sort_order = ?, updated_at = datetime('now', 'localtime') WHERE id = ?
    `).bind(status, priority, item.sort_order !== undefined ? item.sort_order : task.sort_order, item.id));
  }
  if (statements.length) await env.DB.batch(statements);
  return json({ success: true });
}

async function stats(request, env) {
  await requireUser(request, env);
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();
  const monthStart = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-01`;
  const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
  const nextYear = currentMonth === 11 ? currentYear + 1 : currentYear;
  const monthEnd = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-01`;
  const today = now.toISOString().slice(0, 10);

  const totalTasks = await scalar(env, 'SELECT COUNT(*) as c FROM tasks');
  const totalDone = await scalar(env, "SELECT COUNT(*) as c FROM tasks WHERE status = 'done'");
  const doingCount = await scalar(env, "SELECT COUNT(*) as c FROM tasks WHERE status = 'doing'");
  const reviewCount = await scalar(env, "SELECT COUNT(*) as c FROM tasks WHERE status IN ('verify','review')");
  const monthTasks = await scalar(env, 'SELECT COUNT(*) as c FROM tasks WHERE deadline >= ? AND deadline < ?', [monthStart, monthEnd]);
  const monthDone = await scalar(env, "SELECT COUNT(*) as c FROM tasks WHERE deadline >= ? AND deadline < ? AND status = 'done'", [monthStart, monthEnd]);
  const totalProjects = await scalar(env, 'SELECT COUNT(*) as c FROM projects');
  const overdueTasks = await all(env, `
    SELECT t.id, t.title, t.deadline, t.status, t.project_id, t.created_by, p.name as project_name
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.status != 'done' AND t.deadline < ?
    ORDER BY t.deadline ASC
    LIMIT 50
  `, [today]);

  return json({
    totalTasks,
    totalDone,
    monthTasks,
    monthDone,
    doingCount,
    reviewCount,
    overdueCount: overdueTasks.length,
    overdueTasks,
    totalProjects,
    completionRate: totalTasks ? Math.round(totalDone / totalTasks * 100) : 0
  });
}

async function health(env) {
  try {
    const users = await scalar(env, 'SELECT COUNT(*) as c FROM users');
    const projects = await scalar(env, 'SELECT COUNT(*) as c FROM projects');
    const tasks = await scalar(env, 'SELECT COUNT(*) as c FROM tasks');
    return json({
      ok: true,
      db: true,
      users,
      projects,
      tasks,
      hasJwtSecret: Boolean(env.JWT_SECRET),
      hasAdminPassword: Boolean(env.ADMIN_PASSWORD)
    });
  } catch (err) {
    return json({
      ok: false,
      db: false,
      error: err.message,
      hasJwtSecret: Boolean(env.JWT_SECRET),
      hasAdminPassword: Boolean(env.ADMIN_PASSWORD)
    }, 500);
  }
}

async function ensureSeedData(env) {
  if (seedChecked) return;
  const count = await scalar(env, 'SELECT COUNT(*) as c FROM users');
  if (count > 0) {
    seedChecked = true;
    return;
  }
  try {
    await importSeedData(env);
  } catch (err) {
    throw httpError(500, `初始化数据失败: ${err.message}`);
  }
  seedChecked = true;
}

async function importSeedData(env) {
  const seedUsers = Array.isArray(SEED_DATA.users) && SEED_DATA.users.length
    ? SEED_DATA.users
    : [{ username: env.ADMIN_USER || DEFAULT_ADMIN_USER, password: env.ADMIN_PASSWORD, displayName: env.ADMIN_DISPLAY_NAME || DEFAULT_ADMIN_DISPLAY_NAME, role: 'admin' }];
  const userIds = new Map();

  for (const seedUser of seedUsers) {
    const username = String(seedUser.username || '').trim();
    const password = username === (env.ADMIN_USER || DEFAULT_ADMIN_USER) && env.ADMIN_PASSWORD
      ? env.ADMIN_PASSWORD
      : seedUser.password || '';
    const displayName = String(seedUser.displayName || seedUser.display_name || username).trim();
    const role = ['admin', 'member'].includes(seedUser.role) ? seedUser.role : 'member';
    if (!username || !password || !displayName) continue;
    const hashed = await hashPassword(String(password));
    const result = await env.DB.prepare(`
      INSERT INTO users (username, password, display_name, role, avatar)
      VALUES (?, ?, ?, ?, ?)
    `).bind(username, hashed, displayName, role, String(seedUser.avatar || displayName.charAt(0) || 'U')).run();
    userIds.set(username, result.meta.last_row_id);
  }

  if (!userIds.size) {
    if (!env.ADMIN_PASSWORD) throw httpError(500, '缺少 ADMIN_PASSWORD secret，无法创建默认管理员');
    const username = env.ADMIN_USER || DEFAULT_ADMIN_USER;
    const displayName = env.ADMIN_DISPLAY_NAME || DEFAULT_ADMIN_DISPLAY_NAME;
    const hashed = await hashPassword(env.ADMIN_PASSWORD);
    const result = await env.DB.prepare(`
      INSERT INTO users (username, password, display_name, role, avatar)
      VALUES (?, ?, ?, ?, ?)
    `).bind(username, hashed, displayName, 'admin', displayName.charAt(0) || 'A').run();
    userIds.set(username, result.meta.last_row_id);
  }

  const adminId = userIds.get(env.ADMIN_USER || DEFAULT_ADMIN_USER) || [...userIds.values()][0] || null;
  const projects = Array.isArray(SEED_DATA.projects) ? SEED_DATA.projects : [];

  for (const project of projects) {
    const statements = [];
    statements.push(env.DB.prepare(`
      INSERT INTO projects (name, icon, color, description, start_date, end_date, status, priority, role, original_end_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(project.name || project.key || '未命名项目'),
      String(project.icon || ''),
      String(project.color || 'cyan'),
      String(project.description || project.overview?.summary || ''),
      normalizeDate(project.startDate || project.start_date),
      normalizeDate(project.endDate || project.end_date),
      String(project.status || project.overview?.status || ''),
      String(project.projectPriority || project.priority || project.overview?.priority || ''),
      String(project.role || project.overview?.roles || ''),
      String(project.originalEndDate || project.original_end_date || project.overview?.originalEndDate || ''),
      adminId
    ));

    const projectResult = await env.DB.batch(statements);
    const projectId = projectResult[0].meta.last_row_id;
    const childStatements = [];
    for (const userId of userIds.values()) {
      childStatements.push(env.DB.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').bind(projectId, userId));
    }

    const tasks = Array.isArray(project.tasks) ? project.tasks : [];
    let sortOrder = 0;
    for (const task of tasks) {
      const assigneeId = task.assignedTo ? userIds.get(task.assignedTo) || null : null;
      childStatements.push(env.DB.prepare(`
        INSERT INTO tasks (project_id, title, description, status, priority, sort_order, start_date, deadline, assigned_to, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        projectId,
        String(task.title || '未命名任务'),
        String(task.description || ''),
        normalizeStatus(task.status),
        normalizePriority(task.priority),
        sortOrder++,
        normalizeDate(task.startDate || task.start_date),
        normalizeDate(task.deadline) || todayDate(),
        assigneeId,
        assigneeId || adminId
      ));
    }
    if (childStatements.length) await env.DB.batch(childStatements);
  }
}

function normalizeStatus(value) {
  return VALID_STATUSES.has(value) ? value : 'todo';
}

function normalizePriority(value) {
  return VALID_PRIORITIES.has(value) ? value : 'medium';
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\//g, '-').slice(0, 10);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

async function replaceProjectMemberships(env, userId, projectIds) {
  if (!Array.isArray(projectIds)) return;
  const statements = [env.DB.prepare('DELETE FROM project_members WHERE user_id = ?').bind(userId)];
  for (const pid of projectIds) {
    const projectId = Number(pid);
    if (Number.isFinite(projectId)) {
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)').bind(projectId, userId));
    }
  }
  await env.DB.batch(statements);
}

async function checkLoginLimit(env, ip) {
  const now = Date.now();
  const record = await env.DB.prepare('SELECT count, first_attempt FROM login_attempts WHERE ip = ?').bind(ip).first();
  if (!record) return 0;
  if (now - record.first_attempt >= LOGIN_WINDOW_MS) {
    await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
    return 0;
  }
  if (record.count >= MAX_LOGIN_ATTEMPTS) return Math.ceil((LOGIN_WINDOW_MS - (now - record.first_attempt)) / 60000);
  return 0;
}

async function recordFailedLogin(env, ip) {
  const now = Date.now();
  const record = await env.DB.prepare('SELECT count, first_attempt FROM login_attempts WHERE ip = ?').bind(ip).first();
  if (!record || now - record.first_attempt >= LOGIN_WINDOW_MS) {
    await env.DB.prepare('INSERT OR REPLACE INTO login_attempts (ip, count, first_attempt) VALUES (?, ?, ?)').bind(ip, 1, now).run();
    return;
  }
  await env.DB.prepare('UPDATE login_attempts SET count = count + 1 WHERE ip = ?').bind(ip).run();
}

async function clearFailedLogin(env, ip) {
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
}

async function signToken(user, env) {
  const now = Math.floor(Date.now() / 1000);
  const expires = Number(env.JWT_EXPIRES_SECONDS || 86400);
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    display_name: user.display_name,
    avatar: user.avatar || '',
    iat: now,
    exp: now + expires
  };
  const encodedHeader = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(`${encodedHeader}.${encodedPayload}`, jwtSecret(env));
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

async function verifyToken(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = await hmac(`${parts[0]}.${parts[1]}`, jwtSecret(env));
  if (!timingSafeEqual(expected, parts[2])) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function jwtSecret(env) {
  if (!env.JWT_SECRET) throw httpError(500, '缺少 JWT_SECRET secret');
  return env.JWT_SECRET;
}

async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return base64UrlEncodeBytes(new Uint8Array(sig));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await pbkdf2(password, salt, PASSWORD_ITERATIONS);
  return `pbkdf2$${PASSWORD_ITERATIONS}$${base64UrlEncodeBytes(salt)}$${base64UrlEncodeBytes(new Uint8Array(key))}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts[0] !== 'pbkdf2' || parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  const salt = base64UrlToBytes(parts[2]);
  const expected = parts[3];
  const key = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(expected, base64UrlEncodeBytes(new Uint8Array(key)));
}

async function pbkdf2(password, salt, iterations = 150000) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    baseKey,
    256
  );
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) return {};
  try {
    return await request.json();
  } catch {
    throw httpError(400, 'JSON 格式错误');
  }
}

async function all(env, sql, values = []) {
  const result = await env.DB.prepare(sql).bind(...values).all();
  return result.results || [];
}

async function scalar(env, sql, values = []) {
  const row = await env.DB.prepare(sql).bind(...values).first();
  return row?.c || 0;
}

function pickUser(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    avatar: user.avatar
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY'
    }
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function base64UrlEncode(input) {
  return base64UrlEncodeBytes(new TextEncoder().encode(input));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}
