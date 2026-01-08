/* Pool Agnositc Helpders for DB Queries */

export async function queryWithPool(pool, sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function queryWithFieldsWithPool(pool, sql, params = []) {
  const [rows, fields] = await pool.execute(sql, params);
  return { rows, fields };
}
