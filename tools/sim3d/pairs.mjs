import { buildStack, defaultParams } from './build/stack.js';
for (const m of ['12hi', '20hi']) {
  const p = defaultParams(m); Object.assign(p, JSON.parse(process.argv[2] ?? '{}'));
  const st = buildStack(p);
  console.log(m, 'angle1 asked', (p.angle1 * 180 / Math.PI).toFixed(1) + '° used', (st.angle1 * 180 / Math.PI).toFixed(1) + '°', 'issues', st.issues);
  const has = new Set(st.contacts.map(c => `${c.a}-${c.b}`));
  for (let a = 0; a < st.rolls.length; a++) for (let b = a + 1; b < st.rolls.length; b++) {
    const A = st.rolls[a], B = st.rolls[b];
    const d = Math.hypot(A.cy - B.cy, A.cz - B.cz), sum = (A.D + B.D) / 2;
    const gap = d - sum;
    const designated = has.has(`${a}-${b}`);
    if (designated || gap < 0.01) console.log(`  ${A.id.padEnd(6)} ${B.id.padEnd(6)} gap=${(gap * 1e3).toFixed(2).padStart(8)} mm ${designated ? 'CONTACT' : ''} ${!designated && gap < 0 ? '<<< OVERLAP (not modelled)' : designated && Math.abs(gap) > 1e-6 ? '<<< not tangent' : ''}`);
  }
}
