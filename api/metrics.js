const { handleCors, checkAuth, redisGet, json, unauthorized } = require("./_lib/redis");

/**
 * Calculate cycle time for tasks in a specific column (e.g., "In Progress")
 * Cycle Time = Time from when a task enters the column to when it leaves
 */
function calculateCycleTime(board, columnName = "In Progress") {
  const column = board.columns.find(col => col.title === columnName);
  if (!column) return { average: 0, tasks: [] };

  const cycleTimes = [];
  for (const task of column.tasks) {
    // For tasks currently in the column, we can't calculate a full cycle time yet
    // This would require historical data of when tasks entered/left the column
    // For now, we'll just return 0 for in-progress tasks
    if (task.movedAt) {
      const movedAt = new Date(task.movedAt);
      const createdAt = new Date(task.created || task.createdAt);
      const cycleTimeMs = movedAt - createdAt;
      const cycleTimeDays = cycleTimeMs / (1000 * 60 * 60 * 24);
      cycleTimes.push({
        taskId: task.id,
        title: task.title,
        cycleTimeDays: Math.round(cycleTimeDays * 100) / 100 // Round to 2 decimals
      });
    }
  }

  const totalCycleTime = cycleTimes.reduce((sum, ct) => sum + ct.cycleTimeDays, 0);
  const average = cycleTimes.length > 0 ? totalCycleTime / cycleTimes.length : 0;

  return {
    columnName,
    average: Math.round(average * 100) / 100,
    tasks: cycleTimes
  };
}

/**
 * Calculate throughput (number of tasks completed per time period)
 * For simplicity, we'll calculate daily throughput based on tasks in "Done" column
 */
function calculateThroughput(board, columnName = "Done") {
  const column = board.columns.find(col => col.title === columnName);
  if (!column) return { count: 0, tasks: [] };

  // Group tasks by completion date (assuming movedAt is when they were completed)
  const dailyCompletion = {};
  const tasks = [];

  for (const task of column.tasks) {
    if (task.movedAt) {
      const date = new Date(task.movedAt).toISOString().split('T')[0]; // YYYY-MM-DD
      if (!dailyCompletion[date]) dailyCompletion[date] = 0;
      dailyCompletion[date]++;
      
      tasks.push({
        taskId: task.id,
        title: task.title,
        completedAt: task.movedAt
      });
    }
  }

  // Calculate average daily throughput
  const dates = Object.keys(dailyCompletion);
  const totalCompleted = dates.reduce((sum, date) => sum + dailyCompletion[date], 0);
  const averageDaily = dates.length > 0 ? totalCompleted / dates.length : 0;

  return {
    columnName,
    averageDaily: Math.round(averageDaily * 100) / 100,
    totalCompleted,
    dailyCompletion,
    tasks
  };
}

/**
 * Generate Cumulative Flow Diagram data
 * Shows number of tasks in each column over time
 * For this implementation, we'll generate a snapshot of current state
 * A full CFD would require historical data
 */
function generateCFD(board) {
  const cfdData = {
    timestamp: new Date().toISOString(),
    columns: {}
  };

  for (const column of board.columns) {
    cfdData.columns[column.title] = column.tasks.length;
  }

  return cfdData;
}

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (!checkAuth(req)) return unauthorized(res);

  if (req.method !== "GET") {
    return json(res, { error: "Method not allowed" }, 405);
  }

  const board = await redisGet();
  
  // Calculate metrics
  const cycleTime = calculateCycleTime(board);
  const throughput = calculateThroughput(board);
  const cfd = generateCFD(board);

  const metrics = {
    cycleTime,
    throughput,
    cfd,
    generatedAt: new Date().toISOString()
  };

  return json(res, metrics);
};