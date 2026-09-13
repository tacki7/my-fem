import Mathlib.Data.Rat.Defs

/-!
# 2D Q4 要素・組立・求解の厳密な参照値（ℚ）

my-fem `src/sim/element.ts`（平面ひずみ Q4、SRI）、`sparse.ts`（CSR の組立）、`band.ts`
（帯 LDLᵀ）の答え合わせに使う値を、丸めのない有理数で作る。

* 要素は平行四辺形に限る。ヤコビアンが一定なので B は (ξ, η) の 1 次式、BᵀDB は各変数に
  2 次で、コードの 2×2 Gauss もここで使う 3×3 Simpson（点が有理数）も厳密に積分する。
  体積項はコードと同じく重心 1 点（重み 4）
* 要素剛性について、対称・剛体 3 モードが核・ランク 5（アワーグラスモードが無い）を `#guard` で確かめる
* 平行四辺形要素の小さな帯メッシュを組み立て、左端を固定、右端に荷重を与えて厳密に解く

Mathlib 入りの Lean プロジェクトで `lake env lean ExactRef.lean` の標準出力が `tools/exact/reference.json`。
-/

-- 生成スクリプトなので #guard / #eval を使い、長い行も許す
set_option linter.hashCommand false
set_option linter.style.longLine false

namespace ExactRef

abbrev Vec := Array ℚ
abbrev Mat := Array (Array ℚ)

def zeros (n m : Nat) : Mat := Array.replicate n (Array.replicate m 0)

/-- dN/dξ, dN/dη（節点 (−1,−1) (1,−1) (1,1) (−1,1)）— `shapeDerivs` と同じ並び。 -/
def dNref (xi eta : ℚ) : Vec :=
  #[-(1 - eta) / 4, -(1 - xi) / 4, (1 - eta) / 4, -(1 + xi) / 4,
    (1 + eta) / 4, (1 + xi) / 4, -(1 + eta) / 4, (1 - xi) / 4]

/-- (det J, dN/dx, dN/dy を [x0,y0,x1,y1,…] で)。`xe` は [x0,y0,…,x3,y3]。 -/
def cartesian (xe : Vec) (xi eta : ℚ) : ℚ × Vec := Id.run do
  let d := dNref xi eta
  let mut j00 : ℚ := 0; let mut j01 : ℚ := 0; let mut j10 : ℚ := 0; let mut j11 : ℚ := 0
  for k in [0:4] do
    j00 := j00 + d[2 * k]! * xe[2 * k]!
    j01 := j01 + d[2 * k]! * xe[2 * k + 1]!
    j10 := j10 + d[2 * k + 1]! * xe[2 * k]!
    j11 := j11 + d[2 * k + 1]! * xe[2 * k + 1]!
  let det := j00 * j11 - j01 * j10
  let mut out : Vec := Array.replicate 8 0
  for k in [0:4] do
    out := out.set! (2 * k) ((j11 * d[2 * k]! - j01 * d[2 * k + 1]!) / det)
    out := out.set! (2 * k + 1) ((-j10 * d[2 * k]! + j00 * d[2 * k + 1]!) / det)
  return (det, out)

/-- 平面ひずみの Lamé 定数。 -/
def lame (E nu : ℚ) : ℚ × ℚ := (E * nu / ((1 + nu) * (1 - 2 * nu)), E / (2 * (1 + nu)))

/-- SRI の要素剛性 8×8（行優先）。偏差項は 3×3 Simpson、体積項は重心 1 点。 -/
def elementK (E nu : ℚ) (xe : Vec) : Mat := Id.run do
  let (lam, mu) := lame E nu
  let mut K := zeros 8 8
  let pts : Array (ℚ × ℚ) := #[(-1, 1/3), (0, 4/3), (1, 1/3)]
  for (xi, wx) in pts do
    for (eta, wy) in pts do
      let (det, dN) := cartesian xe xi eta
      let w := wx * wy * det
      -- B rows: exx = [dx,0,…], eyy = [0,dy,…], gxy = [dy,dx,…]
      let mut bx : Vec := Array.replicate 8 0
      let mut byy : Vec := Array.replicate 8 0
      let mut bg : Vec := Array.replicate 8 0
      for k in [0:4] do
        bx := bx.set! (2 * k) dN[2 * k]!
        byy := byy.set! (2 * k + 1) dN[2 * k + 1]!
        bg := bg.set! (2 * k) dN[2 * k + 1]!
        bg := bg.set! (2 * k + 1) dN[2 * k]!
      for a in [0:8] do
        for b in [0:8] do
          let v := 2 * mu * w * (bx[a]! * bx[b]! + byy[a]! * byy[b]!) + mu * w * (bg[a]! * bg[b]!)
          K := K.modify a (·.modify b (· + v))
  let (det0, dN0) := cartesian xe 0 0
  for a in [0:8] do
    for b in [0:8] do
      K := K.modify a (·.modify b (· + lam * 4 * det0 * dN0[a]! * dN0[b]!))
  return K

def mulVec (A : Mat) (x : Vec) : Vec :=
  A.map fun row => Id.run do
    let mut s : ℚ := 0
    for j in [0:x.size] do s := s + row[j]! * x[j]!
    return s

def isSymmetric (A : Mat) : Bool := Id.run do
  for i in [0:A.size] do
    for j in [0:A.size] do
      if A[i]![j]! != A[j]![i]! then return false
  return true

/-- 行基本変形でランクを数える。 -/
def rank (A : Mat) : Nat := Id.run do
  let n := A.size
  let m := if n = 0 then 0 else A[0]!.size
  let mut M := A
  let mut r := 0
  for c in [0:m] do
    let mut p := n
    for i in [r:n] do
      if p = n && M[i]![c]! != 0 then p := i
    if p < n then
      let tmp := M[r]!
      M := (M.set! r M[p]!).set! p tmp
      for i in [0:n] do
        if i != r && M[i]![c]! != 0 then
          let f := M[i]![c]! / M[r]![c]!
          let pivotRow := M[r]!
          M := M.modify i fun row => Id.run do
            let mut row := row
            for j in [0:m] do row := row.set! j (row[j]! - f * pivotRow[j]!)
            return row
      r := r + 1
  return r

/-- 正則な連立方程式をガウスの消去法で解く（部分ピボット：非零を探すだけ）。 -/
def solve (A : Mat) (b : Vec) : Vec := Id.run do
  let n := A.size
  let mut M := A
  let mut y := b
  for k in [0:n] do
    let mut p := k
    for i in [k:n] do
      if M[p]![k]! == 0 && M[i]![k]! != 0 then p := i
    if p != k then
      let tmp := M[k]!
      M := (M.set! k M[p]!).set! p tmp
      let ty := y[k]!
      y := (y.set! k y[p]!).set! p ty
    let pivotRow := M[k]!
    let piv := pivotRow[k]!
    for i in [k + 1:n] do
      let f := M[i]![k]! / piv
      if f != 0 then
        M := M.modify i fun row => Id.run do
          let mut row := row
          for j in [k:n] do row := row.set! j (row[j]! - f * pivotRow[j]!)
          return row
        y := y.set! i (y[i]! - f * y[k]!)
  let mut x : Vec := Array.replicate n 0
  for kk in [0:n] do
    let k := n - 1 - kk
    let mut s := y[k]!
    for j in [k + 1:n] do s := s - M[k]![j]! * x[j]!
    x := x.set! k (s / M[k]![k]!)
  return x

/-! ## 参照ケース -/

def E : ℚ := 210
def nu : ℚ := 3 / 10

/-- 1 要素: 平行四辺形 (0,0) (2,0) (5/2,1) (1/2,1)。 -/
def xeOne : Vec := #[0, 0, 2, 0, 5/2, 1, 1/2, 1]
def Kone : Mat := elementK E nu xeOne

/-- 剛体モード: x 並進、y 並進、原点まわりの回転 (u, v) = (−y, x)。 -/
def rigidModes (xe : Vec) : Array Vec :=
  #[#[1, 0, 1, 0, 1, 0, 1, 0], #[0, 1, 0, 1, 0, 1, 0, 1],
    Id.run do
      let mut v : Vec := Array.replicate 8 0
      for k in [0:4] do
        v := (v.set! (2 * k) (-xe[2 * k + 1]!)).set! (2 * k + 1) xe[2 * k]!
      return v]

#guard isSymmetric Kone
#guard (rigidModes xeOne).all fun m => (mulVec Kone m).all (· == 0)
#guard rank Kone == 5

/-- 帯メッシュ: nx × ny 要素、節点 (i, j) の番号 i (ny+1) + j、座標 (i dx + j s, j dy)。 -/
structure MeshSpec where
  nx : Nat
  ny : Nat
  dx : ℚ
  dy : ℚ
  shear : ℚ

def mesh : MeshSpec := ⟨4, 2, 1, 1/2, 1/4⟩

def nodeId (m : MeshSpec) (i j : Nat) : Nat := i * (m.ny + 1) + j
def nodeXY (m : MeshSpec) (i j : Nat) : ℚ × ℚ := (i * m.dx + j * m.shear, j * m.dy)

def quads (m : MeshSpec) : Array (Array Nat) := Id.run do
  let mut out := #[]
  for i in [0:m.nx] do
    for j in [0:m.ny] do
      out := out.push #[nodeId m i j, nodeId m (i + 1) j, nodeId m (i + 1) (j + 1), nodeId m i (j + 1)]
  return out

def coords (m : MeshSpec) : Vec := Id.run do
  let nn := (m.nx + 1) * (m.ny + 1)
  let mut X : Vec := Array.replicate (2 * nn) 0
  for i in [0:m.nx + 1] do
    for j in [0:m.ny + 1] do
      let (x, y) := nodeXY m i j
      X := (X.set! (2 * nodeId m i j) x).set! (2 * nodeId m i j + 1) y
  return X

def assemble (m : MeshSpec) : Mat := Id.run do
  let X := coords m
  let n := 2 * (m.nx + 1) * (m.ny + 1)
  let mut K := zeros n n
  for q in quads m do
    let xe : Vec := Id.run do
      let mut v := #[]
      for k in [0:4] do v := (v.push X[2 * q[k]!]!).push X[2 * q[k]! + 1]!
      return v
    let Ke := elementK E nu xe
    for a in [0:8] do
      for b in [0:8] do
        let ra := 2 * q[a / 2]! + a % 2
        let cb := 2 * q[b / 2]! + b % 2
        K := K.modify ra (·.modify cb (· + Ke[a]![b]!))
  return K

/-- 左端 (i = 0) の節点を両方向固定。 -/
def free (m : MeshSpec) : Array Bool := Id.run do
  let mut f := Array.replicate (2 * (m.nx + 1) * (m.ny + 1)) true
  for j in [0:m.ny + 1] do
    f := (f.set! (2 * nodeId m 0 j) false).set! (2 * nodeId m 0 j + 1) false
  return f

/-- 荷重: 右上の節点に下向き 1、右下の節点に右向き 1/2。 -/
def load (m : MeshSpec) : Vec := Id.run do
  let mut f := Array.replicate (2 * (m.nx + 1) * (m.ny + 1)) 0
  f := f.set! (2 * nodeId m m.nx m.ny + 1) (-1)
  f := f.set! (2 * nodeId m m.nx 0) (1/2)
  return f

def Kmesh : Mat := assemble mesh

/-- 自由度を絞って解き、固定自由度に 0 を戻す。 -/
def displacement : Vec := Id.run do
  let fr := free mesh
  let idx := (List.range fr.size).toArray.filter (fr[·]!)
  let Kff : Mat := idx.map fun r => idx.map fun c => Kmesh[r]![c]!
  let ff : Vec := idx.map fun r => (load mesh)[r]!
  let uf := solve Kff ff
  let mut u : Vec := Array.replicate fr.size 0
  for k in [0:idx.size] do u := u.set! idx[k]! uf[k]!
  return u

#guard isSymmetric Kmesh
-- 自由度の行で K u = f が厳密に成り立つ
#guard Id.run do
  let fr := free mesh
  let Ku := mulVec Kmesh displacement
  let f := load mesh
  let mut ok := true
  for i in [0:fr.size] do
    if fr[i]! && Ku[i]! != f[i]! then ok := false
  return ok

/-! ## JSON -/

def q (x : ℚ) : String := "\"" ++ toString x ++ "\""
def vecJ (v : Vec) : String := "[" ++ ", ".intercalate (v.toList.map q) ++ "]"
def matJ (A : Mat) : String := "[\n    " ++ ",\n    ".intercalate (A.toList.map vecJ) ++ "]"
def natsJ (v : Array Nat) : String := "[" ++ ", ".intercalate (v.toList.map toString) ++ "]"

def json : String :=
  "{\n" ++
  s!"  \"E\": {q E}, \"nu\": {q nu},\n" ++
  s!"  \"element\": \{\"xe\": {vecJ xeOne}, \"rank\": {rank Kone},\n  \"K\": {matJ Kone}},\n" ++
  s!"  \"mesh\": \{\"nx\": {mesh.nx}, \"ny\": {mesh.ny}, \"dx\": {q mesh.dx}, \"dy\": {q mesh.dy}, \"shear\": {q mesh.shear},\n" ++
  s!"  \"quads\": [{", ".intercalate ((quads mesh).toList.map natsJ)}],\n" ++
  s!"  \"X\": {vecJ (coords mesh)},\n" ++
  s!"  \"free\": [{", ".intercalate ((free mesh).toList.map fun b => if b then "1" else "0")}],\n" ++
  s!"  \"f\": {vecJ (load mesh)},\n" ++
  s!"  \"u\": {vecJ displacement},\n" ++
  s!"  \"K\": {matJ Kmesh}}\n" ++
  "}"

#eval IO.println json

end ExactRef
