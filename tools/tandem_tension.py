#!/usr/bin/env python3
"""タンデム冷間圧延の動的連続圧延理論（スタンド間張力）シミュレータ.

参考文献の 5.4 節「冷間圧延の動的連続圧延理論」(5.37)〜(5.52) 式を実装したもの。

  (5.37) 板厚（ゲージメータ）式   h_i = S_i + P_i / M_i
  (5.38) 圧延荷重式               P_i = P(H_i, h_i, q_fi, q_bi, k_i, mu_i, b)   … Hill の式
  (5.39) 出側材料速度             v_out,i = (1 + f_i) v_Ri
  (5.40) 入側材料速度             v_in,i  = (1 + eps_i) v_Ri
  (5.41) 後進率                   eps = (1 + f) h / H - 1
  (5.42) 先進率                   f_i = f(H_i, h_i, q_fi, q_bi, mu_i, k_i)      … Bland & Ford の式
  スタンド間張力の扱いは 3 通り（--model で選択）:
  (1) simple  (5.44)(5.45)  q_fi = E/L ∫ (v_in,i+1 - v_out,i) dt,  q_b,i+1 = h_i/H_i+1 * q_fi
  (2) dist    (5.46)-(5.49) 板厚分布を考慮: T_i = 1/Σ(1/K_j) ∫ Δv dt, K_j = E b h_j / l_j
  (3) rigid   (5.50)-(5.52) スタンド間剛体: v_out,i-1 H_i = v_out,i h_i,  h_i q_fi = H_i+1 q_b,i+1

5.4.2 節の計算例は (3) を使っているので、本スクリプトの既定も rigid。
表 5.5 のドラフトスケジュールを既定値として持ち、図 5.16〜5.27 に対応する 6 ケースの
外乱応答（素材板厚・#1/#5 圧下・#1/#3/#5 ロール速度のステップ）を計算する。

単位系は本文と同じ kgf, mm, s。

本文に無い値（ロール半径・ミル定数・摩擦係数・スタンド間距離）は既定値を置いてあり、
すべて CLI から変更できる。既定値の根拠は Mill dataclass のコメントを参照。

使い方:
    python3 tools/tandem_tension.py --self-test          # 検証スイート
    python3 tools/tandem_tension.py --case all --plot    # 全 6 ケース + 図
    python3 tools/tandem_tension.py --case entry --model simple --model-compare
    python3 tools/tandem_tension.py --case entry --tension-control   # 張力 PI 制御あり
"""

from __future__ import annotations

import argparse
import csv
import math
import os
import sys
from collections import deque
from dataclasses import dataclass, field, replace
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np


# ---------------------------------------------------------------------------
# 圧延機・材料の諸元
# ---------------------------------------------------------------------------


@dataclass
class Mill:
    """圧延機と材料の諸元（既定値は表 5.5 のドラフトスケジュール）。"""

    n: int = 5
    b: float = 930.0                      # 材料幅 [mm]              （表 5.5）
    h_entry: float = 3.20                 # 素板厚 [mm]              （表 5.5）
    barrel: float = 1420.0                # ロールバレル長 [mm]      （表 5.5、報告用）
    h_sched: Tuple[float, ...] = (2.64, 2.10, 1.67, 1.34, 1.20)   # 出側板厚 [mm]
    # 張力 [kgf/mm^2]。表 5.5 の「後方」行 (0, 15.3, 20.5, 22.5, 19.3) と
    # 「前方」行 (15.3, 20.3, 22.5, 19.3, 6.3) は #2 前方だけ 20.3 / 20.5 と食い違う。
    # (5.52) 式（定常では q_f,i = q_b,i+1）と矛盾するので、後方行を正として 20.5 を採用した。
    qf_sched: Tuple[float, ...] = (15.3, 20.5, 22.5, 19.3, 6.3)
    qb_first: float = 0.0                 # #1 後方張力（ペイオフリール側）
    v_ref_stand: int = 4                  # 速度基準スタンド（1 起算）  （表 5.5）
    v_ref: float = 6000.0                 # そのスタンドの圧延速度 [mm/s]（表 5.5）

    # --- 以下は本文に記載が無い。冷間タンデムミルの一般値を既定にしてある ---
    R: Tuple[float, ...] = (265.0,) * 5   # ワークロール半径 [mm]（バレル 1420 mm 級の 4Hi）
    M: Tuple[float, ...] = (5.0e5,) * 5   # ミル定数 [kgf/mm]（= 500 tf/mm）
    mu: Tuple[float, ...] = (0.05,) * 5   # 摩擦係数（エマルジョン潤滑の冷延で 0.03〜0.08）
    L: Tuple[float, ...] = (4500.0,) * 4  # スタンド間距離 [mm]（図 5.17 の伝播時刻に整合）

    # 変形抵抗 S = a (r + b0)^m [kgf/mm^2]、r は素板からの累積圧下率（表 5.5）
    ks_a: float = 84.6
    ks_b: float = 0.00817
    ks_m: float = 0.30

    e_strip: float = 21000.0              # 材料ヤング率 [kgf/mm^2]
    e_roll: float = 21000.0               # ロールのヤング率 [kgf/mm^2]
    poisson: float = 0.30
    w_back: float = 0.5                   # 荷重式の張力重み: k_eff = kbar - (w q_b + (1-w) q_f)
    arm: float = 0.45                     # トルクアーム係数（報告用）
    rp_cap: float = 30.0                  # 扁平ロール半径の上限（R' <= rp_cap * R）

    @property
    def hitchcock_c(self) -> float:
        """Hitchcock の扁平係数 C = 16 (1 - nu^2) / (pi E_roll) [mm^2/kgf]."""
        return 16.0 * (1.0 - self.poisson ** 2) / (math.pi * self.e_roll)

    def entry_thickness(self, i: int) -> float:
        """スケジュール上の第 i スタンド入側板厚（i は 0 起算）。"""
        return self.h_entry if i == 0 else self.h_sched[i - 1]

    def qb_sched(self, i: int) -> float:
        """スケジュール上の第 i スタンド後方張力（i は 0 起算）。"""
        return self.qb_first if i == 0 else self.qf_sched[i - 1]


# ---------------------------------------------------------------------------
# 1 スタンドの圧延モデル（荷重・先進率）
# ---------------------------------------------------------------------------


@dataclass
class StandResult:
    P: float          # 圧延荷重 [kgf]
    Rp: float         # 扁平ロール半径 R' [mm]
    f: float          # 先進率
    eps: float        # 後進率
    kbar: float       # 平均変形抵抗 [kgf/mm^2]
    k_in: float
    k_out: float
    torque: float     # 圧延トルク（2 ロール分）[kgf mm]


def deformation_resistance(mill: Mill, r: float) -> float:
    """累積圧下率 r における変形抵抗 S(r) [kgf/mm^2]（表 5.5 の式）。"""
    return mill.ks_a * (max(r, 0.0) + mill.ks_b) ** mill.ks_m


def mean_deformation_resistance(mill: Mill, r_in: float, r_out: float) -> float:
    """パス中の平均変形抵抗（r について解析的に平均）。"""
    if r_out - r_in < 1e-9:
        return deformation_resistance(mill, r_out)
    m1 = mill.ks_m + 1.0
    return (
        mill.ks_a
        * ((r_out + mill.ks_b) ** m1 - (r_in + mill.ks_b) ** m1)
        / (m1 * (r_out - r_in))
    )


def evaluate_stand(
    mill: Mill,
    i: int,
    H: float,
    h: float,
    qb: float,
    qf: float,
    rp_guess: Optional[float] = None,
) -> StandResult:
    """第 i スタンド（0 起算）の圧延荷重 (5.38) と先進率 (5.42) を計算する。

    荷重は Hill の式、先進率は Bland & Ford の式（本文 5.4.1 節の注記どおり）。
    ロール扁平は Hitchcock の式で反復して求める。
    """
    R, mu, b = mill.R[i], mill.mu[i], mill.b
    dh = H - h
    if dh <= 1e-7:
        # 圧下ゼロ: 荷重も先進率も 0（噛み込んでいない状態の極限）
        k = deformation_resistance(mill, max(0.0, 1.0 - h / mill.h_entry))
        return StandResult(0.0, R, 0.0, h / H - 1.0, k, k, k, 0.0)

    r_in = max(0.0, 1.0 - H / mill.h_entry)
    r_out = max(0.0, 1.0 - h / mill.h_entry)
    kbar = mean_deformation_resistance(mill, r_in, r_out)
    k_in = deformation_resistance(mill, r_in)
    k_out = deformation_resistance(mill, r_out)

    # 張力による荷重低減（前後張力の重み付き平均を変形抵抗から差し引く）
    k_eff = max(kbar - (mill.w_back * qb + (1.0 - mill.w_back) * qf), 0.05 * kbar)

    rp = dh / H                                   # 圧下率
    Rp = rp_guess if rp_guess else R
    P = 0.0
    for _ in range(60):
        Qp = 1.08 - 1.02 * rp + 1.79 * mu * rp * math.sqrt(Rp / h)
        P = b * math.sqrt(Rp * dh) * Qp * k_eff
        Rp_new = min(R * (1.0 + mill.hitchcock_c * P / (b * dh)), mill.rp_cap * R)
        if abs(Rp_new - Rp) <= 1e-10 * Rp:
            Rp = Rp_new
            break
        Rp = Rp_new
    Qp = 1.08 - 1.02 * rp + 1.79 * mu * rp * math.sqrt(Rp / h)
    P = b * math.sqrt(Rp * dh) * Qp * k_eff

    # --- Bland & Ford の先進率 ---
    s = math.sqrt(h / Rp)
    alpha = math.sqrt(dh / Rp)                    # 噛み込み角
    H0 = 2.0 / s * math.atan(alpha / s)
    num = max(1.0 - qb / k_in, 1e-3)
    den = max(1.0 - qf / k_out, 1e-3)
    Hn = 0.5 * H0 + (1.0 / (2.0 * mu)) * math.log((h / H) * num / den)
    Hn = min(max(Hn, 0.0), H0)                    # 中立点は接触弧内
    phin = s * math.tan(Hn * s / 2.0)
    hn = h + 2.0 * Rp * (1.0 - math.cos(phin))    # 中立点板厚
    f = hn * math.cos(phin) / h - 1.0
    eps = (1.0 + f) * h / H - 1.0                 # (5.41)

    torque = 2.0 * mill.arm * math.sqrt(Rp * dh) * P + Rp * b * (qb * H - qf * h)
    return StandResult(P, Rp, f, eps, kbar, k_in, k_out, torque)


def solve_exit_thickness(
    mill: Mill,
    i: int,
    S: float,
    H: float,
    qb: float,
    qf: float,
    h_guess: float,
    rp_guess: Optional[float] = None,
) -> Tuple[float, StandResult]:
    """ゲージメータ式 (5.37) h = S + P(h)/M を h について解く（二分法で保護した Newton 法）。

    g(h) = h - S - P(h)/M は h について単調増加なので解は一意。
    """
    M = mill.M[i]

    def g(h: float) -> Tuple[float, StandResult]:
        res = evaluate_stand(mill, i, H, h, qb, qf, rp_guess)
        return h - S - res.P / M, res

    lo = max(S, 1e-4)
    hi = H - 1e-9
    if lo >= hi:                                   # ロールギャップが入側板厚以上（無圧下）
        res = evaluate_stand(mill, i, H, H, qb, qf, rp_guess)
        return H, res
    g_lo, res_lo = g(lo)
    if g_lo >= 0.0:                                # 圧下がかからない（異常設定）
        return lo, res_lo

    h = min(max(h_guess, lo + 1e-9), hi)
    gh, res = g(h)
    for _ in range(80):
        if abs(gh) < 1e-12:
            break
        if gh > 0.0:
            hi = h
        else:
            lo = h
        # 数値微分による Newton ステップ
        dh_num = max(1e-7 * h, 1e-9)
        g2, _ = g(h + dh_num)
        slope = (g2 - gh) / dh_num
        h_new = h - gh / slope if slope > 0.0 else 0.5 * (lo + hi)
        if not (lo < h_new < hi):
            h_new = 0.5 * (lo + hi)
        if abs(h_new - h) < 1e-14:
            h = h_new
            gh, res = g(h)
            break
        h = h_new
        gh, res = g(h)
    return h, res


# ---------------------------------------------------------------------------
# 初期設定計算（図 5.13 の「初期設定計算」に相当）
# ---------------------------------------------------------------------------


@dataclass
class Setup:
    mill: Mill
    S: List[float]        # ロールギャップ [mm]
    vR: List[float]       # ロール周速 [mm/s]
    P: List[float]        # 圧延荷重 [kgf]
    f: List[float]        # 先進率
    eps: List[float]      # 後進率
    Rp: List[float]       # 扁平ロール半径 [mm]
    torque: List[float]   # トルク [kgf mm]
    v_out: List[float]    # 出側材料速度 [mm/s]
    flow: float           # 単位幅体積速度 h*v_out [mm^2/s]


def compute_setup(mill: Mill) -> Setup:
    """スケジュール（板厚・張力）を実現するロールギャップとロール速度を求める。"""
    S, P, f, eps, Rp, torque = [], [], [], [], [], []
    for i in range(mill.n):
        H = mill.entry_thickness(i)
        h = mill.h_sched[i]
        res = evaluate_stand(mill, i, H, h, mill.qb_sched(i), mill.qf_sched[i])
        S.append(h - res.P / mill.M[i])            # (5.37) の逆算
        P.append(res.P)
        f.append(res.f)
        eps.append(res.eps)
        Rp.append(res.Rp)
        torque.append(res.torque)

    # 体積速度一定（定常）: h_i v_out,i = 一定。基準スタンドのロール速度から決める。
    ref = mill.v_ref_stand - 1
    flow = mill.h_sched[ref] * (1.0 + f[ref]) * mill.v_ref
    v_out = [flow / mill.h_sched[i] for i in range(mill.n)]
    vR = [v_out[i] / (1.0 + f[i]) for i in range(mill.n)]
    return Setup(mill, S, vR, P, f, eps, Rp, torque, v_out, flow)


# ---------------------------------------------------------------------------
# スタンド間の板（Lagrange 的なスライス列）— 搬送遅れと板厚分布
# ---------------------------------------------------------------------------


class StripQueue:
    """スタンド間の材料。上流出側で押し込み、下流入側で取り出す。

    数値拡散を避けるため固定格子ではなく可変長スライスの列で持つ（図 5.11 の板厚分布）。
    """

    def __init__(self, length: float, thickness: float) -> None:
        self.slices: deque = deque([[length, thickness]])

    def front_thickness(self) -> float:
        return self.slices[0][1]

    def segments(self) -> List[List[float]]:
        return list(self.slices)

    def total_length(self) -> float:
        return sum(sl[0] for sl in self.slices)

    def push(self, length: float, thickness: float) -> None:
        if length <= 0.0:
            return
        back = self.slices[-1]
        if abs(back[1] - thickness) < 1e-10:
            back[0] += length
        else:
            self.slices.append([length, thickness])

    def pop(self, length: float) -> float:
        """先頭から length 分を取り出し、その質量平均板厚を返す。"""
        if length <= 0.0:
            return self.slices[0][1]
        remaining, mass = length, 0.0
        while remaining > 1e-12 and self.slices:
            l, h = self.slices[0]
            take = min(l, remaining)
            mass += take * h
            remaining -= take
            if take >= l - 1e-12:
                if len(self.slices) == 1:
                    # 枯渇しかけ: 同じ板厚を残して打ち切る（通常は起きない）
                    self.slices[0][0] = 1e-9
                    break
                self.slices.popleft()
            else:
                self.slices[0][0] = l - take
        consumed = length - remaining
        return mass / consumed if consumed > 0.0 else self.slices[0][1]


# ---------------------------------------------------------------------------
# 外乱・制御の定義
# ---------------------------------------------------------------------------


@dataclass
class Disturbance:
    kind: str          # 'entry' | 'gap' | 'speed'
    stand: int         # 1 起算（entry では無視）
    rel: float         # 相対量: entry は ΔH/H, gap は ΔS/h, speed は ΔVR/VR
    t0: float = 0.0


@dataclass
class TensionControl:
    """スタンド間張力の PI 制御（上流スタンドのロール速度を操作）。

    本文 5.4 節には制御則そのものは書かれていない（動特性モデルは制御系設計に使う、
    という位置づけ）。ここでは「張力制御を入れると何が変わるか」を見るための最小構成。
    """

    enabled: bool = False
    kp: float = 0.0        # [(mm/s)/(kgf/mm^2)]
    ki: float = 30.0       # [(mm/s)/(kgf/mm^2)/s]
    v_limit: float = 0.10  # ロール速度操作量の上限（比率）


@dataclass
class Actuators:
    """駆動モータ・圧下装置の動特性（図 5.14 / 図 5.15）。

    5.4.2 節の計算例では「駆動モータ、圧下装置の動特性は考慮していない」ので既定は無効。
    """

    asr_tau: float = 0.0      # ロール速度 1 次遅れ時定数 [s]
    sd_enabled: bool = False  # 圧下位置制御ループ（図 5.15）
    # ゲインは 1/p・1 次遅れ・むだ時間を含む一巡伝達関数の位相余裕が 45 度程度になる値
    sd_gain: float = 10.0     # 関数発生器のゲイン [1/s]
    sd_vmax: float = 2.0      # 圧下速度リミット [mm/s]
    sd_t1: float = 0.05       # 圧下 ASR の 1 次遅れ [s]
    sd_t2: float = 0.03       # むだ時間 [s]


# ---------------------------------------------------------------------------
# Newton 法（rigid モデルの連立式用）
# ---------------------------------------------------------------------------


def newton_solve(
    fun: Callable[[np.ndarray], np.ndarray],
    x0: np.ndarray,
    tol: float = 1e-11,
    maxit: int = 40,
) -> Tuple[np.ndarray, float, int]:
    x = np.array(x0, dtype=float)
    F = fun(x)
    nrm = float(np.max(np.abs(F)))
    it = 0
    for it in range(1, maxit + 1):
        if nrm < tol:
            break
        n = x.size
        J = np.empty((n, n))
        for j in range(n):
            step = 1e-7 * max(abs(x[j]), 1e-3)
            xp = x.copy()
            xp[j] += step
            J[:, j] = (fun(xp) - F) / step
        try:
            dx = np.linalg.solve(J, -F)
        except np.linalg.LinAlgError:
            dx = -F
        lam = 1.0
        for _ in range(25):                      # 残差が減るまで刻み幅を半分に
            xn = x + lam * dx
            Fn = fun(xn)
            nn = float(np.max(np.abs(Fn)))
            if nn < nrm:
                break
            lam *= 0.5
        x, F, nrm = xn, Fn, nn
    return x, nrm, it


# ---------------------------------------------------------------------------
# シミュレータ
# ---------------------------------------------------------------------------


@dataclass
class Result:
    case: str
    model: str
    t: np.ndarray
    h: np.ndarray          # (n, nt) 出側板厚 [mm]
    qf: np.ndarray         # (n-1, nt) 前方（= スタンド間）張力 [kgf/mm^2]
    P: np.ndarray          # (n, nt) 圧延荷重 [kgf]
    vR: np.ndarray         # (n, nt) ロール周速 [mm/s]
    H: np.ndarray          # (n, nt) 入側板厚 [mm]
    h0: np.ndarray         # 定常値
    qf0: np.ndarray
    solver_iters: int
    max_residual: float

    @property
    def dh(self) -> np.ndarray:
        return self.h - self.h0[:, None]

    @property
    def dqf(self) -> np.ndarray:
        return self.qf - self.qf0[:, None]


class Simulator:
    """タンデムミルの動特性計算（図 5.13 のフローチャートに対応）。"""

    def __init__(
        self,
        mill: Mill,
        setup: Setup,
        model: str = "rigid",
        dt: float = 2e-3,
        actuators: Optional[Actuators] = None,
        control: Optional[TensionControl] = None,
    ) -> None:
        self.mill = mill
        self.setup = setup
        self.model = model
        self.dt = dt
        self.act = actuators or Actuators()
        self.ctrl = control or TensionControl()

        n = mill.n
        self.h = list(mill.h_sched)
        self.qf = [mill.qf_sched[i] for i in range(n - 1)]      # スタンド間張力（#n 前方は固定）
        self.T = [self.qf[i] * mill.b * mill.h_sched[i] for i in range(n - 1)]  # 全張力 [kgf]
        self.S = list(setup.S)
        self.S_cmd = list(setup.S)
        self.vR = list(setup.vR)
        self.vR_cmd = list(setup.vR)
        self.rp = list(setup.Rp)
        self.H_entry = mill.h_entry
        self.queues = [StripQueue(mill.L[i], mill.h_sched[i]) for i in range(n - 1)]
        self.ctrl_int = [0.0] * (n - 1)
        self.sd_state = [0.0] * n            # 圧下 ASR の 1 次遅れ出力
        self.sd_delay: List[deque] = [deque() for _ in range(n)]
        self.iters = 0
        self.max_res = 0.0

    # -- 各スタンドの入側板厚 -------------------------------------------------
    def entry_thicknesses(self) -> List[float]:
        H = [self.H_entry]
        for i in range(self.mill.n - 1):
            H.append(self.queues[i].front_thickness())
        return H

    # -- 張力の割り当て -------------------------------------------------------
    def tensions(self, H: List[float], h: Sequence[float], qf: Sequence[float]) -> Tuple[List[float], List[float]]:
        """各スタンドの (後方, 前方) 張力。(5.45)/(5.49)/(5.52) の張力つり合いを使う。"""
        mill = self.mill
        qb_all = [mill.qb_first]
        qf_all = list(qf) + [mill.qf_sched[-1]]
        for i in range(1, mill.n):
            if self.model == "dist":
                qb_all.append(self.T[i - 1] / (mill.b * H[i]))     # (5.49)
            else:
                qb_all.append(qf_all[i - 1] * h[i - 1] / H[i])     # (5.45)/(5.52)
        return qb_all, qf_all

    # -- 1 ステップ -----------------------------------------------------------
    def step(self) -> Dict[str, List[float]]:
        mill, n = self.mill, self.mill.n
        H = self.entry_thicknesses()

        if self.model == "rigid":
            # (5.50)-(5.52): 未知数 h_1..h_n, q_f1..q_f,n-1 の連立非線形方程式を Newton 法で解く
            x0 = np.array(list(self.h) + list(self.qf))

            def residual(x: np.ndarray) -> np.ndarray:
                h = [float(v) for v in x[:n]]
                qf = [float(v) for v in x[n:]]
                qb_all, qf_all = self.tensions(H, h, qf)
                res_out, v_out, v_in = [], [], []
                for i in range(n):
                    r = evaluate_stand(mill, i, H[i], h[i], qb_all[i], qf_all[i], self.rp[i])
                    res_out.append(r)
                    v_out.append((1.0 + r.f) * self.vR[i])         # (5.39)
                    v_in.append((1.0 + r.eps) * self.vR[i])        # (5.40)
                out = np.empty(2 * n - 1)
                for i in range(n):
                    out[i] = (h[i] - self.S[i] - res_out[i].P / mill.M[i]) / mill.h_sched[i]
                for i in range(1, n):
                    out[n + i - 1] = (v_in[i] - v_out[i - 1]) / v_out[i - 1]
                return out

            x, res_norm, iters = newton_solve(residual, x0)
            self.iters += iters
            self.max_res = max(self.max_res, res_norm)
            self.h = [float(v) for v in x[:n]]
            self.qf = [float(v) for v in x[n:]]
        else:
            # (1)(2): 張力は状態量。各スタンドの板厚はゲージメータ式から独立に解ける。
            if self.model == "dist":
                self.qf = [self.T[i] / (mill.b * self.h[i]) for i in range(n - 1)]  # (5.48)
            qb_all, qf_all = self.tensions(H, self.h, self.qf)
            for i in range(n):
                self.h[i], r = solve_exit_thickness(
                    mill, i, self.S[i], H[i], qb_all[i], qf_all[i], self.h[i], self.rp[i]
                )

        # 収束した状態でスタンド量を再評価
        qb_all, qf_all = self.tensions(H, self.h, self.qf)
        results, v_out, v_in = [], [], []
        for i in range(n):
            r = evaluate_stand(mill, i, H[i], self.h[i], qb_all[i], qf_all[i], self.rp[i])
            self.rp[i] = r.Rp
            results.append(r)
            v_out.append((1.0 + r.f) * self.vR[i])
            v_in.append((1.0 + r.eps) * self.vR[i])

        # 搬送（スタンド間の板を進める）
        for i in range(n - 1):
            self.queues[i].push(v_out[i] * self.dt, self.h[i])
            v_take = v_out[i] if self.model == "rigid" else v_in[i + 1]
            self.queues[i].pop(v_take * self.dt)

        # 張力の積分（弾性モデルのみ）
        if self.model == "simple":
            for i in range(n - 1):
                dv = v_in[i + 1] - v_out[i]
                self.qf[i] += (mill.e_strip / mill.L[i]) * dv * self.dt      # (5.44)
                self.T[i] = self.qf[i] * mill.b * self.h[i]
        elif self.model == "dist":
            for i in range(n - 1):
                inv_k = 0.0
                for l_j, h_j in self.queues[i].segments():
                    inv_k += l_j / (mill.e_strip * mill.b * h_j)             # (5.47)
                k_eq = 1.0 / inv_k if inv_k > 0 else 0.0
                dv = v_in[i + 1] - v_out[i]
                self.T[i] += k_eq * dv * self.dt                              # (5.46)

        return {
            "H": H,
            "h": list(self.h),
            "qf": list(self.qf),
            "P": [r.P for r in results],
            "f": [r.f for r in results],
            "v_out": v_out,
            "v_in": v_in,
            "torque": [r.torque for r in results],
        }

    # -- アクチュエータと制御 -------------------------------------------------
    def apply_actuators(self) -> None:
        act = self.act
        if act.asr_tau > 0.0:
            a = self.dt / act.asr_tau
            for i in range(self.mill.n):
                self.vR[i] += a * (self.vR_cmd[i] - self.vR[i])
        else:
            self.vR = list(self.vR_cmd)

        if act.sd_enabled:
            for i in range(self.mill.n):
                err = self.S_cmd[i] - self.S[i]
                u = max(-act.sd_vmax, min(act.sd_vmax, act.sd_gain * err))   # 関数発生器
                self.sd_state[i] += (self.dt / act.sd_t1) * (u - self.sd_state[i])  # 1/(1+pT1)
                buf = self.sd_delay[i]
                buf.append(self.sd_state[i])                                  # e^{-T2 p}
                ndelay = max(1, int(round(act.sd_t2 / self.dt)))
                u_del = buf.popleft() if len(buf) > ndelay else 0.0
                self.S[i] += u_del * self.dt                                  # 1/p
        else:
            self.S = list(self.S_cmd)

    def apply_control(self) -> None:
        if not self.ctrl.enabled:
            return
        for i in range(self.mill.n - 1):
            err = self.qf[i] - self.mill.qf_sched[i]     # 張力が高い → 上流を増速して緩める
            self.ctrl_int[i] += err * self.dt
            dv = self.ctrl.kp * err + self.ctrl.ki * self.ctrl_int[i]
            lim = self.ctrl.v_limit * self.setup.vR[i]
            if abs(dv) > lim:                            # アンチワインドアップ
                dv = math.copysign(lim, dv)
                self.ctrl_int[i] -= err * self.dt
            self.vR_cmd[i] = self.setup.vR[i] + dv


def run_case(
    mill: Mill,
    setup: Setup,
    dist: Optional[Disturbance],
    model: str = "rigid",
    tmax: float = 8.0,
    dt: float = 2e-3,
    actuators: Optional[Actuators] = None,
    control: Optional[TensionControl] = None,
    case_name: str = "",
    n_record: int = 1600,
) -> Result:
    sim = Simulator(mill, setup, model=model, dt=dt, actuators=actuators, control=control)
    nsteps = int(round(tmax / dt))
    stride = max(1, nsteps // n_record)

    t_rec: List[float] = []
    h_rec: List[List[float]] = []
    qf_rec: List[List[float]] = []
    P_rec: List[List[float]] = []
    vR_rec: List[List[float]] = []
    H_rec: List[List[float]] = []

    for k in range(nsteps + 1):
        t = k * dt
        # --- 外乱の印加 ---
        if dist is not None and t >= dist.t0 - 1e-12:
            if dist.kind == "entry":
                sim.H_entry = mill.h_entry * (1.0 + dist.rel)
            elif dist.kind == "gap":
                j = dist.stand - 1
                sim.S_cmd[j] = setup.S[j] + dist.rel * mill.h_sched[j]
            elif dist.kind == "speed":
                j = dist.stand - 1
                sim.vR_cmd[j] = setup.vR[j] * (1.0 + dist.rel)
        sim.apply_control()
        sim.apply_actuators()
        out = sim.step()
        if k % stride == 0 or k == nsteps:
            t_rec.append(t)
            h_rec.append(out["h"])
            qf_rec.append(out["qf"])
            P_rec.append(out["P"])
            vR_rec.append(list(sim.vR))
            H_rec.append(out["H"])

    return Result(
        case=case_name,
        model=model,
        t=np.array(t_rec),
        h=np.array(h_rec).T,
        qf=np.array(qf_rec).T,
        P=np.array(P_rec).T,
        vR=np.array(vR_rec).T,
        H=np.array(H_rec).T,
        h0=np.array(mill.h_sched),
        qf0=np.array(mill.qf_sched[: mill.n - 1]),
        solver_iters=sim.iters,
        max_residual=sim.max_res,
    )


# ---------------------------------------------------------------------------
# ケース定義と本文の記述による検証
# ---------------------------------------------------------------------------

CASES: Dict[str, Tuple[Optional[Disturbance], str]] = {
    "entry":  (Disturbance("entry", 0, 0.05), "素材板厚 +5% ステップ（図 5.16 / 5.17）"),
    "gap1":   (Disturbance("gap", 1, 0.05),   "#1 圧下 (ΔS/h)=+0.05（図 5.18 / 5.19）"),
    "gap5":   (Disturbance("gap", 5, 0.05),   "#5 圧下 (ΔS/h)=+0.05（図 5.20 / 5.21）"),
    "speed1": (Disturbance("speed", 1, 0.01), "#1 速度 +1%（図 5.22 / 5.23）"),
    "speed3": (Disturbance("speed", 3, 0.01), "#3 速度 +1%（図 5.24 / 5.25）"),
    "speed5": (Disturbance("speed", 5, 0.01), "#5 速度 +1%（図 5.26 / 5.27）"),
    "none":   (None, "外乱なし（定常確認）"),
}

# 図 5.16〜5.27 から読み取った値（グラフ読み取りなので ±10% 程度の精度）。
# ロール半径・ミル定数・摩擦係数・スタンド間距離が本文に無いため、一致は桁と符号・
# 順序を見るためのもので、数値そのものの再現は期待できない。
BOOK_VALUES: Dict[str, Dict[str, float]] = {
    "entry":  {"dh1_init": 0.034, "dh1_final": 0.038, "dh5_final": 0.016,
               "dqf1_final": -0.88, "dqf3_final": -0.58, "t_arrive_2": 1.45, "t_arrive_5": 4.8},
    "gap1":   {"dh1_init": 0.051, "dh1_final": 0.058, "dh5_final": 0.020, "dqf1_final": -0.85},
    "gap5":   {"dh5_init": 0.007, "dh5_final": 0.0035, "dh4_final": -0.0055, "dqf4_final": 1.65},
    "speed1": {"dh1_final": 0.0038, "dh2_final": 0.012, "dh5_final": 0.0072,
               "dqf1_final": -0.87, "dqf2_final": -0.55},
    "speed3": {"dqf2_final": 0.95, "dqf3_final": -0.75, "dqf4_final": -0.45},
    "speed5": {"dqf4_final": 1.6},
}


def check_conclusions(case: str, r: Result) -> List[Tuple[str, str, bool]]:
    """本文 122〜124 ページの結論 (1)〜(6) を符号で自動判定する。"""
    dh, dq = r.dh[:, -1], r.dqf[:, -1]
    dh_init = r.dh[:, min(5, r.dh.shape[1] - 1)]
    out: List[Tuple[str, str, bool]] = []

    def add(desc: str, ok: bool, actual: str) -> None:
        out.append((desc, actual, ok))

    if case == "entry":
        add("(1) 板厚変化部が到達したスタンドの板厚が増加", all(dh > 0),
            "Δh = " + ", ".join(f"{v:+.4f}" for v in dh))
        add("(1) スタンド間張力は減少", all(dq < 0),
            "Δq_f = " + ", ".join(f"{v:+.3f}" for v in dq))
        add("(1) #1 出側板厚は次スタンド到達後さらに増加", dh[0] > dh_init[0] * 1.001,
            f"Δh1 初期 {dh_init[0]:+.4f} → 最終 {dh[0]:+.4f}")
    elif case == "gap1":
        add("(2) #1 出側板厚が増加", dh[0] > 0, f"Δh1 = {dh[0]:+.4f}")
        add("(2) 各スタンドを通過するたび板厚は増加しつづける", all(dh > 0),
            "Δh = " + ", ".join(f"{v:+.4f}" for v in dh))
        add("(2) スタンド間張力は減少", all(dq < 0),
            "Δq_f = " + ", ".join(f"{v:+.3f}" for v in dq))
    elif case == "gap5":
        add("(3) 瞬間的に #5 出側板厚が増加", dh_init[4] > 0, f"Δh5 初期 = {dh_init[4]:+.5f}")
        add("(3) 4〜5 スタンド間張力が増加", dq[3] > 0, f"Δq_f4 = {dq[3]:+.3f}")
        add("(3) #4 出側板厚は減少", dh[3] < 0, f"Δh4 = {dh[3]:+.5f}")
        add("(3) #5 出側板厚は最終的にあまり変化しない",
            abs(dh[4]) < abs(dh_init[4]), f"Δh5 初期 {dh_init[4]:+.5f} → 最終 {dh[4]:+.5f}")
    elif case == "speed1":
        add("(4) 1〜2 スタンド間張力が低下", dq[0] < 0, f"Δq_f1 = {dq[0]:+.3f}")
        add("(4) #1 出側板厚が増大", dh[0] > 0, f"Δh1 = {dh[0]:+.5f}")
        add("(4) 最終スタンド出側板厚も増大", dh[4] > 0, f"Δh5 = {dh[4]:+.5f}")
        add("(4) スタンド間張力は全体に減少", all(dq < 0),
            "Δq_f = " + ", ".join(f"{v:+.3f}" for v in dq))
    elif case == "speed3":
        add("(5) 3〜4 スタンド間張力は減少", dq[2] < 0, f"Δq_f3 = {dq[2]:+.3f}")
        add("(5) 2〜3 スタンド間張力は増加", dq[1] > 0, f"Δq_f2 = {dq[1]:+.3f}")
        add("(5) #5 出側板厚は最終的にほとんど変化しない",
            abs(dh[4]) < 0.2 * max(abs(dh[2]), 1e-9),
            f"Δh5 = {dh[4]:+.5f} (Δh3 = {dh[2]:+.5f})")
    elif case == "speed5":
        add("(6) 4〜5 スタンド間張力が増加", dq[3] > 0, f"Δq_f4 = {dq[3]:+.3f}")
        add("(6) #5 出側板厚は減少", dh[4] < 0, f"Δh5 = {dh[4]:+.5f}")
        add("(6) #4 出側板厚も減少", dh[3] < 0, f"Δh4 = {dh[3]:+.5f}")
    return out


def arrival_time(r: Result, stand: int) -> Optional[float]:
    """板厚変化部がそのスタンドに到達した時刻。

    張力を介した変化は全スタンドに瞬時に伝わるので「しきい値を超えた時刻」では
    到達を判定できない（rigid モデルでは張力が代数的に伝わる）。板厚変化部の
    到達は階段状の飛びとして出るので、最大の時間差分で判定する。
    """
    d = r.dh[stand - 1]
    if abs(d[-1]) < 1e-9:
        return None
    jumps = np.abs(np.diff(d))
    if jumps.size == 0 or float(np.max(jumps)) < 1e-9:
        return None
    return float(r.t[int(np.argmax(jumps)) + 1])


# ---------------------------------------------------------------------------
# 出力
# ---------------------------------------------------------------------------


def print_setup(setup: Setup) -> None:
    mill = setup.mill
    print("=" * 78)
    print("初期設定計算（表 5.5 のスケジュールを実現する設定値）")
    print("=" * 78)
    print(f"  素板厚 {mill.h_entry} mm / 幅 {mill.b} mm / バレル長 {mill.barrel} mm")
    print(f"  変形抵抗 S = {mill.ks_a}(r + {mill.ks_b})^{mill.ks_m} kgf/mm^2")
    print(f"  仮定値: R = {mill.R[0]:.0f} mm, M = {mill.M[0]:.3g} kgf/mm, "
          f"mu = {mill.mu[0]:.3f}, L = {mill.L[0]:.0f} mm")
    print(f"  体積速度 h*v_out = {setup.flow:.0f} mm^2/s "
          f"(#{mill.v_ref_stand} 圧延速度 {mill.v_ref:.0f} mm/s 基準)")
    print()
    hdr = f"  {'':14s}" + "".join(f"{i + 1:>12d}" for i in range(mill.n))
    print(hdr)
    rows = [
        ("入側板厚 [mm]", [mill.entry_thickness(i) for i in range(mill.n)], "{:12.3f}"),
        ("出側板厚 [mm]", list(mill.h_sched), "{:12.3f}"),
        ("圧下率 [%]", [100 * (1 - mill.h_sched[i] / mill.entry_thickness(i)) for i in range(mill.n)], "{:12.1f}"),
        ("後方張力", [mill.qb_sched(i) for i in range(mill.n)], "{:12.1f}"),
        ("前方張力", list(mill.qf_sched), "{:12.1f}"),
        ("荷重 [tf]", [p / 1000.0 for p in setup.P], "{:12.1f}"),
        ("R' [mm]", setup.Rp, "{:12.1f}"),
        ("先進率 [%]", [100 * v for v in setup.f], "{:12.2f}"),
        ("ロールギャップ", setup.S, "{:12.3f}"),
        ("ロール周速", setup.vR, "{:12.1f}"),
        ("出側速度", setup.v_out, "{:12.1f}"),
        ("トルク [tf m]", [t / 1e6 for t in setup.torque], "{:12.1f}"),
    ]
    for name, vals, fmt in rows:
        print(f"  {name:14s}" + "".join(fmt.format(v) for v in vals))
    print()


def print_case_summary(r: Result, mill: Mill, book_compare: bool = True) -> None:
    print("-" * 78)
    print(f"[{r.case}] {CASES[r.case][1]}   model={r.model}")
    print("-" * 78)
    dh, dq = r.dh[:, -1], r.dqf[:, -1]
    print("  最終偏差  Δh   [mm]      " + "".join(f"{v:+11.5f}" for v in dh))
    print("  最終偏差  Δq_f [kgf/mm^2]" + "".join(f"{v:+11.4f}" for v in dq))
    arrivals = [arrival_time(r, i + 1) for i in range(mill.n)]
    print("  板厚変化到達時刻 [s]     " +
          "".join(f"{('---' if a is None else f'{a:.2f}'):>11s}" for a in arrivals))
    if not book_compare:
        print("  （制御・アクチュエータ動特性を入れているので本文の結論との照合はしない）")
    checks = check_conclusions(r.case, r) if book_compare else []
    if checks:
        print("  本文の結論との照合:")
        for desc, actual, ok in checks:
            print(f"    [{'OK ' if ok else 'NG '}] {desc}\n           {actual}")
    book = BOOK_VALUES.get(r.case) if book_compare else None
    if book:
        print("  図からの読み取り値との比較（本文に無い諸元を仮定しているので目安）:")
        for key, bval in book.items():
            cval = _computed_metric(r, key)
            if cval is None:
                continue
            ratio = cval / bval if abs(bval) > 1e-12 else float("nan")
            print(f"    {key:14s} 図 {bval:+9.4f}   計算 {cval:+9.4f}   比 {ratio:6.2f}")
    print()


def _computed_metric(r: Result, key: str) -> Optional[float]:
    init_idx = min(5, r.dh.shape[1] - 1)
    if key.startswith("dh"):
        i = int(key[2]) - 1
        return float(r.dh[i, -1] if key.endswith("final") else r.dh[i, init_idx])
    if key.startswith("dqf"):
        i = int(key[3]) - 1
        return float(r.dqf[i, -1] if key.endswith("final") else r.dqf[i, init_idx])
    if key.startswith("t_arrive_"):
        return arrival_time(r, int(key.split("_")[-1]))
    return None


def setup_japanese_font() -> bool:
    import matplotlib
    from matplotlib import font_manager

    names = {f.name for f in font_manager.fontManager.ttflist}
    for cand in ("Hiragino Sans", "Hiragino Maru Gothic Pro", "Noto Sans CJK JP",
                 "IPAexGothic", "YuGothic", "Arial Unicode MS"):
        if cand in names:
            matplotlib.rcParams["font.family"] = cand
            matplotlib.rcParams["axes.unicode_minus"] = False
            return True
    return False


def plot_case(r: Result, mill: Mill, outdir: str, jp: bool) -> str:
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2))
    title = CASES[r.case][1] if jp else r.case
    for i in range(mill.n - 1):
        axes[0].plot(r.t, r.dqf[i], lw=1.4, label=f"$\\Delta q_{{f{i + 1}}}$")
    axes[0].set_xlabel("経過時間 [s]" if jp else "time [s]")
    axes[0].set_ylabel("各スタンド間の張力変化 [kgf/mm$^2$]" if jp else "d q_f [kgf/mm2]")
    axes[0].axhline(0, color="k", lw=0.6)
    axes[0].legend(fontsize=8, ncol=2)
    axes[0].grid(alpha=0.3)

    for i in range(mill.n):
        axes[1].plot(r.t, r.dh[i], lw=1.4, label=f"$\\Delta h_{{{i + 1}}}$")
    axes[1].set_xlabel("経過時間 [s]" if jp else "time [s]")
    axes[1].set_ylabel("各スタンド出側板厚偏差 [mm]" if jp else "d h [mm]")
    axes[1].axhline(0, color="k", lw=0.6)
    axes[1].legend(fontsize=8, ncol=2)
    axes[1].grid(alpha=0.3)

    fig.suptitle(f"{title}   [{r.model}]", fontsize=11)
    fig.tight_layout()
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, f"{r.case}_{r.model}.png")
    fig.savefig(path, dpi=130)
    plt.close(fig)
    return path


def write_csv(r: Result, mill: Mill, outdir: str) -> str:
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, f"{r.case}_{r.model}.csv")
    with open(path, "w", newline="") as fp:
        w = csv.writer(fp)
        w.writerow(
            ["t"]
            + [f"h{i + 1}" for i in range(mill.n)]
            + [f"qf{i + 1}" for i in range(mill.n - 1)]
            + [f"P{i + 1}" for i in range(mill.n)]
        )
        for k in range(r.t.size):
            w.writerow(
                [f"{r.t[k]:.4f}"]
                + [f"{r.h[i, k]:.6f}" for i in range(mill.n)]
                + [f"{r.qf[i, k]:.5f}" for i in range(mill.n - 1)]
                + [f"{r.P[i, k]:.1f}" for i in range(mill.n)]
            )
    return path


# ---------------------------------------------------------------------------
# 検証スイート
# ---------------------------------------------------------------------------


def self_test(mill: Mill, setup: Setup, tmax: float = 6.0) -> bool:
    print("=" * 78)
    print("検証スイート")
    print("=" * 78)
    ok_all = True

    def report(name: str, ok: bool, detail: str) -> None:
        nonlocal ok_all
        ok_all = ok_all and ok
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}\n         {detail}")

    # 1. 設定値の整合: S から板厚を解き直してスケジュールに戻るか
    err = 0.0
    for i in range(mill.n):
        h, _ = solve_exit_thickness(
            mill, i, setup.S[i], mill.entry_thickness(i),
            mill.qb_sched(i), mill.qf_sched[i], mill.h_sched[i]
        )
        err = max(err, abs(h - mill.h_sched[i]))
    report("初期設定計算の往復（S → h）", err < 1e-9, f"最大誤差 {err:.2e} mm")

    # 2. 体積速度一定
    flows = [mill.h_sched[i] * setup.v_out[i] for i in range(mill.n)]
    dev = max(flows) / min(flows) - 1.0
    report("定常の体積速度一定", dev < 1e-12, f"h*v_out のばらつき {dev:.2e}")

    # 3. 外乱なしで各モデルがドリフトしないか
    for model, dt in (("rigid", 4e-3), ("simple", 5e-4), ("dist", 5e-4)):
        r = run_case(mill, setup, None, model=model, tmax=2.0, dt=dt, case_name="none")
        dh = float(np.max(np.abs(r.dh)))
        dq = float(np.max(np.abs(r.dqf)))
        report(f"定常保持 ({model})", dh < 1e-6 and dq < 1e-3,
               f"最大 |Δh| = {dh:.2e} mm, 最大 |Δq_f| = {dq:.2e} kgf/mm^2")

    # 4. 弾性モデル (1)(2) は定常で剛体モデル (3) に一致するはず
    ref = run_case(mill, setup, CASES["entry"][0], model="rigid", tmax=tmax, dt=4e-3, case_name="entry")
    for model in ("simple", "dist"):
        r = run_case(mill, setup, CASES["entry"][0], model=model, tmax=tmax, dt=5e-4, case_name="entry")
        dh = float(np.max(np.abs(r.dh[:, -1] - ref.dh[:, -1])))
        dq = float(np.max(np.abs(r.dqf[:, -1] - ref.dqf[:, -1])))
        report(f"最終値が rigid と一致 ({model})", dh < 2e-4 and dq < 0.05,
               f"Δh の差 {dh:.2e} mm, Δq_f の差 {dq:.3f} kgf/mm^2")

    # 5. 時間刻みの収束（dt を半分にしても結果が変わらない）
    r1 = run_case(mill, setup, CASES["entry"][0], model="rigid", tmax=tmax, dt=4e-3, case_name="entry")
    r2 = run_case(mill, setup, CASES["entry"][0], model="rigid", tmax=tmax, dt=2e-3, case_name="entry")
    dh = float(np.max(np.abs(r1.dh[:, -1] - r2.dh[:, -1])))
    report("dt を半分にしても最終値が変わらない (rigid)", dh < 1e-5, f"最大差 {dh:.2e} mm")

    r3 = run_case(mill, setup, CASES["entry"][0], model="simple", tmax=tmax, dt=5e-4, case_name="entry")
    r4 = run_case(mill, setup, CASES["entry"][0], model="simple", tmax=tmax, dt=2.5e-4, case_name="entry")
    dq = float(np.max(np.abs(r3.dqf[:, -1] - r4.dqf[:, -1])))
    report("dt を半分にしても最終値が変わらない (simple)", dq < 5e-3, f"最大差 {dq:.2e} kgf/mm^2")

    # 6. Newton 法の残差
    report("rigid の Newton 残差", ref.max_residual < 1e-9, f"最大残差 {ref.max_residual:.2e}")

    # 7. アクチュエータ動特性は過渡を変えるだけで最終値を変えない
    g_ideal = run_case(mill, setup, CASES["gap1"][0], model="rigid", tmax=6.0, dt=2e-3, case_name="gap1")
    g_dyn = run_case(mill, setup, CASES["gap1"][0], model="rigid", tmax=6.0, dt=2e-3, case_name="gap1",
                     actuators=Actuators(sd_enabled=True, asr_tau=0.1))
    dh = float(np.max(np.abs(g_ideal.dh[:, -1] - g_dyn.dh[:, -1])))
    peak = float(np.max(g_dyn.dh[0])) > float(g_dyn.dh[0, -1]) * 1.02   # 圧下ループの行き過ぎ
    report("圧下・ASR 動特性を入れても最終値は同じ", dh < 1e-3 and peak,
           f"最終値差 {dh:.2e} mm, 圧下ループのオーバーシュートあり={peak}")

    # 8. 張力制御を入れるとスタンド間張力が目標へ戻る
    c_off = run_case(mill, setup, CASES["entry"][0], model="rigid", tmax=8.0, dt=2e-3, case_name="entry")
    c_on = run_case(mill, setup, CASES["entry"][0], model="rigid", tmax=8.0, dt=2e-3, case_name="entry",
                    control=TensionControl(enabled=True))
    off = float(np.max(np.abs(c_off.dqf[:, -1])))
    on = float(np.max(np.abs(c_on.dqf[:, -1])))
    report("張力 PI 制御で張力偏差が縮む", on < 0.1 * off,
           f"制御なし {off:.3f} → 制御あり {on:.3f} kgf/mm^2")

    print()
    print(f"  => {'全て PASS' if ok_all else 'FAIL あり'}")
    print()
    return ok_all


def sensitivity_report(mill: Mill, setup: Setup) -> None:
    """設定値まわりの感度（許容誤差を決めるのに要る）。"""
    print("=" * 78)
    print("定常点まわりの感度（1 スタンド単独、他スタンドの反作用は含まない）")
    print("=" * 78)
    print(f"  {'':10s}" + "".join(f"{i + 1:>12d}" for i in range(mill.n)))
    dh_dS, dh_dH, dh_dqf, dP_dqb = [], [], [], []
    for i in range(mill.n):
        H = mill.entry_thickness(i)
        h = mill.h_sched[i]
        qb, qf = mill.qb_sched(i), mill.qf_sched[i]
        base, _ = solve_exit_thickness(mill, i, setup.S[i], H, qb, qf, h)
        hp, _ = solve_exit_thickness(mill, i, setup.S[i] + 1e-3, H, qb, qf, h)
        dh_dS.append((hp - base) / 1e-3)
        hp, _ = solve_exit_thickness(mill, i, setup.S[i], H + 1e-3, qb, qf, h)
        dh_dH.append((hp - base) / 1e-3)
        hp, _ = solve_exit_thickness(mill, i, setup.S[i], H, qb, qf + 0.1, h)
        dh_dqf.append((hp - base) / 0.1)
        r0 = evaluate_stand(mill, i, H, h, qb, qf)
        r1 = evaluate_stand(mill, i, H, h, qb + 0.1, qf)
        dP_dqb.append((r1.P - r0.P) / 0.1 / 1000.0)
    for name, vals, fmt in (
        ("∂h/∂S", dh_dS, "{:12.3f}"),
        ("∂h/∂H", dh_dH, "{:12.3f}"),
        ("∂h/∂q_f", dh_dqf, "{:12.5f}"),
        ("∂P/∂q_b [tf]", dP_dqb, "{:12.3f}"),
    ):
        print(f"  {name:10s}" + "".join(fmt.format(v) for v in vals))
    print()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_mill(args: argparse.Namespace) -> Mill:
    n = 5
    mill = Mill()
    if args.roll_radius is not None:
        mill = replace(mill, R=(args.roll_radius,) * n)
    if args.mill_modulus is not None:
        mill = replace(mill, M=(args.mill_modulus,) * n)
    if args.mu is not None:
        mill = replace(mill, mu=(args.mu,) * n)
    if args.stand_distance is not None:
        mill = replace(mill, L=(args.stand_distance,) * (n - 1))
    if args.tension_weight is not None:
        mill = replace(mill, w_back=args.tension_weight)
    return mill


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = argparse.ArgumentParser(
        description="タンデム冷間圧延の動的連続圧延理論（スタンド間張力）シミュレータ",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--case", default="all",
                   help="計算ケース: " + ", ".join(CASES) + ", all")
    p.add_argument("--model", default="rigid", choices=("rigid", "simple", "dist"),
                   help="張力モデル: rigid=(5.50)-(5.52), simple=(5.44)(5.45), dist=(5.46)-(5.49)")
    p.add_argument("--model-compare", action="store_true", help="3 つの張力モデルを比較する")
    p.add_argument("--tmax", type=float, default=8.0, help="計算時間 [s]")
    p.add_argument("--dt", type=float, default=None,
                   help="時間刻み [s]（既定: rigid 2e-3、弾性モデル 5e-4）")
    p.add_argument("--plot", action="store_true", help="図を出力する")
    p.add_argument("--csv", action="store_true", help="時系列を CSV 出力する")
    p.add_argument("--outdir", default="tools/out", help="図・CSV の出力先")
    p.add_argument("--self-test", action="store_true", help="検証スイートを実行して終了")
    p.add_argument("--sensitivity", action="store_true", help="定常点まわりの感度を表示")
    p.add_argument("--tension-control", action="store_true", help="スタンド間張力の PI 制御を入れる")
    p.add_argument("--kp", type=float, default=0.0, help="張力制御の比例ゲイン")
    p.add_argument("--ki", type=float, default=30.0, help="張力制御の積分ゲイン")
    p.add_argument("--asr-tau", type=float, default=0.0, help="ロール速度の 1 次遅れ時定数 [s]（図 5.14）")
    p.add_argument("--screwdown-dyn", action="store_true", help="圧下位置制御の動特性を入れる（図 5.15）")
    p.add_argument("--roll-radius", type=float, default=None, help="ワークロール半径 [mm]")
    p.add_argument("--mill-modulus", type=float, default=None, help="ミル定数 [kgf/mm]")
    p.add_argument("--mu", type=float, default=None, help="摩擦係数")
    p.add_argument("--stand-distance", type=float, default=None, help="スタンド間距離 [mm]")
    p.add_argument("--tension-weight", type=float, default=None,
                   help="荷重式の後方張力重み w（k_eff = k - w q_b - (1-w) q_f）")
    args = p.parse_args(argv)

    mill = build_mill(args)
    setup = compute_setup(mill)
    print_setup(setup)

    if args.sensitivity:
        sensitivity_report(mill, setup)

    if args.self_test:
        return 0 if self_test(mill, setup) else 1

    cases = list(CASES) if args.case == "all" else args.case.split(",")
    for c in cases:
        if c not in CASES:
            p.error(f"未知のケース: {c}")
    if args.case == "all":
        cases = [c for c in cases if c != "none"]

    models = ("rigid", "simple", "dist") if args.model_compare else (args.model,)
    actuators = Actuators(asr_tau=args.asr_tau, sd_enabled=args.screwdown_dyn)
    control = TensionControl(enabled=args.tension_control, kp=args.kp, ki=args.ki)

    jp = setup_japanese_font() if args.plot else False
    if args.plot and not jp:
        print("  （日本語フォントが見つからないので図のラベルは英語にする）")

    for c in cases:
        dist = CASES[c][0]
        for model in models:
            dt = args.dt if args.dt else (2e-3 if model == "rigid" else 5e-4)
            r = run_case(mill, setup, dist, model=model, tmax=args.tmax, dt=dt,
                         actuators=actuators, control=control, case_name=c)
            plain = not (control.enabled or actuators.sd_enabled or actuators.asr_tau > 0.0)
            print_case_summary(r, mill, book_compare=plain)
            if args.plot:
                print(f"  図: {plot_case(r, mill, args.outdir, jp)}")
            if args.csv:
                print(f"  CSV: {write_csv(r, mill, args.outdir)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
