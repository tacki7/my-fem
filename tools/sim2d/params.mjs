// The app's default RollingParams, as a stand in the app actually receives them.
//
// The defaults live in src/app/defaults.ts (no DOM, built with the sim2d preset), so they
// are imported rather than sliced out of main.ts's source.
//
// They are not quite what the app runs, though. A few dials are held in `view` in the
// units an operator types (MN/mm, m/min, a strip width), and at boot they are converted
// into `params` (syncMillModulus, syncRollSpeed, syncAgcTarget in main.ts). The conversions
// that reach a stand are redone here with the same functions:
//
//   millModulus    = millModulusMNmm * MN_PER_MM / stripWidth     (per unit width)
//   agcTargetForce = agcTargetTonf * TONF / stripWidth            (per unit width; the
//                    per-stand setups are seeded from the same conversion)
//   omega          = rollSpeedMpm / 60 / R
//   lineSpeed      = rollSpeedMpm / 60
//
// One set of params is not converted and still parts from the app: the analysis window.
// While `autoFit` is on (the default) the app copies the window the selected stand's
// solver fitted into the shared params at boot and after every rebuild or refit
// (syncWindowDials in main.ts): windowIn / windowOut / biteGrade become -29.24 / 14.62 mm
// / 0.959 on the default first stand. Here they stay the literal -40 / 25 mm / 0.90.
// With autoFit on that changes nothing - each solver fits its own window and ignores these
// three. A harness that sets `autoFit: false` would solve on the literal window, where the
// app, switched to manual, keeps the fitted one; patch windowIn / windowOut / biteGrade to
// the values the app shows when measuring that way.
//
// The patch is applied after the conversions, as a dial changed by hand would be.
import {
  defaultParams as appParams, defaultView,
  millModulusPerWidth, agcTargetPerWidth, omegaFromMpm, lineSpeedFromMpm,
} from './build/app/defaults.js';

export function defaultParams(patch = {}) {
  const params = appParams();
  const view = defaultView();
  params.millModulus = millModulusPerWidth(view);
  params.agcTargetForce = agcTargetPerWidth(view);
  params.omega = omegaFromMpm(view, params.R);
  params.lineSpeed = lineSpeedFromMpm(view);
  return { ...params, ...patch };
}
