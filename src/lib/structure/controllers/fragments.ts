/**
 * 铅笔模式的分子片段数据（纯常量，无 reactive 状态）
 *
 * 每个 MolecularFragment 定义一个可放置的分子构建块:
 * - name: 显示名称 (Benzene, Methyl, ...)
 * - category: 用于 UI 分组 (ring/alkyl/chain/functional)
 * - formula: 化学式（用下标 Unicode 显示）
 * - connect_idx: 连接到锚点原子的原子索引
 * - bond_length: 锚点到连接原子的默认键长 (Å)
 * - sites: 片段中所有原子的元素和 xyz 坐标（相对于连接原子）
 */

import type { ElementSymbol, Vec3 } from '$lib'

export interface MolecularFragment {
  name: string
  category: 'ring' | 'alkyl' | 'chain' | 'functional'
  formula: string
  connect_idx: number
  bond_length: number
  sites: Array<{ element: ElementSymbol; xyz: Vec3 }>
}

export const molecular_fragments: MolecularFragment[] = [
  // ─── 环状结构 (Rings) ───
  {
    name: 'Benzene',
    category: 'ring',
    formula: 'C₆H₅',
    connect_idx: 0,
    bond_length: 1.50,
    sites: [
      { element: 'C', xyz: [0, 0, 0] },
      { element: 'C', xyz: [1.21, 0.70, 0] },
      { element: 'C', xyz: [1.21, 2.10, 0] },
      { element: 'C', xyz: [0, 2.80, 0] },
      { element: 'C', xyz: [-1.21, 2.10, 0] },
      { element: 'C', xyz: [-1.21, 0.70, 0] },
      { element: 'H', xyz: [2.16, 0.16, 0] },
      { element: 'H', xyz: [2.16, 2.64, 0] },
      { element: 'H', xyz: [0, 3.89, 0] },
      { element: 'H', xyz: [-2.16, 2.64, 0] },
      { element: 'H', xyz: [-2.16, 0.16, 0] },
    ],
  },
  {
    name: 'Cyclopentane',
    category: 'ring',
    formula: 'C₅H₉',
    connect_idx: 0,
    bond_length: 1.54,
    sites: [
      { element: 'C', xyz: [0, 0, 0] },
      { element: 'C', xyz: [1.12, 0.81, 0] },
      { element: 'C', xyz: [0.69, 2.13, 0] },
      { element: 'C', xyz: [-0.69, 2.13, 0] },
      { element: 'C', xyz: [-1.12, 0.81, 0] },
      { element: 'H', xyz: [2.09, 0.33, 0] },
      { element: 'H', xyz: [1.29, 2.90, 0] },
      { element: 'H', xyz: [-1.29, 2.90, 0] },
      { element: 'H', xyz: [-2.09, 0.33, 0] },
    ],
  },
  {
    name: 'Cyclohexane',
    category: 'ring',
    formula: 'C₆H₁₁',
    connect_idx: 0,
    bond_length: 1.54,
    sites: [
      { element: 'C', xyz: [0, 0, 0] },
      { element: 'C', xyz: [1.26, 0.73, 0.43] },
      { element: 'C', xyz: [1.26, 2.19, -0.08] },
      { element: 'C', xyz: [0, 2.92, 0.43] },
      { element: 'C', xyz: [-1.26, 2.19, -0.08] },
      { element: 'C', xyz: [-1.26, 0.73, 0.43] },
      { element: 'H', xyz: [2.16, 0.19, 0.10] },
      { element: 'H', xyz: [2.16, 2.73, 0.25] },
      { element: 'H', xyz: [0, 3.92, 0.01] },
      { element: 'H', xyz: [-2.16, 2.73, 0.25] },
      { element: 'H', xyz: [-2.16, 0.19, 0.10] },
    ],
  },
  // ─── 烷基 (Alkyl groups) ───
  {
    name: 'Methyl',
    category: 'alkyl',
    formula: 'CH₃',
    connect_idx: 0,
    bond_length: 1.54,
    sites: [
      { element: 'C', xyz: [0, 0, 0] },
      { element: 'H', xyz: [0.63, 0.63, 0.63] },
      { element: 'H', xyz: [-0.63, -0.63, 0.63] },
      { element: 'H', xyz: [0.63, -0.63, -0.63] },
    ],
  },
  {
    name: 'Ethyl',
    category: 'alkyl',
    formula: 'C₂H₅',
    connect_idx: 0,
    bond_length: 1.54,
    sites: [
      { element: 'C', xyz: [0, 0, 0] },
      { element: 'C', xyz: [1.54, 0, 0] },
      { element: 'H', xyz: [-0.51, 0.89, 0.36] },
      { element: 'H', xyz: [-0.51, -0.89, 0.36] },
      { element: 'H', xyz: [2.05, 0.89, -0.36] },
      { element: 'H', xyz: [2.05, -0.89, -0.36] },
      { element: 'H', xyz: [2.05, 0, 0.89] },
    ],
  },
  {
    name: 'Isopropyl',
    category: 'alkyl',
    formula: 'C₃H₇',
    connect_idx: 0,
    bond_length: 1.54,
    sites: [
      { element: 'C', xyz: [0, 0, 0] },
      { element: 'C', xyz: [1.26, 0.73, 0] },
      { element: 'C', xyz: [-1.26, 0.73, 0] },
      { element: 'H', xyz: [0, -1.09, 0] },
      { element: 'H', xyz: [1.26, 1.36, 0.89] },
      { element: 'H', xyz: [1.26, 1.36, -0.89] },
      { element: 'H', xyz: [2.16, 0.10, 0] },
      { element: 'H', xyz: [-1.26, 1.36, 0.89] },
      { element: 'H', xyz: [-1.26, 1.36, -0.89] },
      { element: 'H', xyz: [-2.16, 0.10, 0] },
    ],
  },
  // ─── 链状结构 (Chains) ───
  {
    name: 'Propyl',
    category: 'chain',
    formula: 'C₃H₇',
    connect_idx: 0,
    bond_length: 1.54,
    sites: [
      { element: 'C', xyz: [0, 0, 0] },
      { element: 'C', xyz: [1.54, 0, 0] },
      { element: 'C', xyz: [2.31, 1.26, 0] },
      { element: 'H', xyz: [-0.51, 0.89, 0.36] },
      { element: 'H', xyz: [-0.51, -0.89, 0.36] },
      { element: 'H', xyz: [2.05, -0.89, 0.36] },
      { element: 'H', xyz: [2.05, -0.36, -0.89] },
      { element: 'H', xyz: [3.40, 1.08, 0] },
      { element: 'H', xyz: [2.05, 1.80, 0.89] },
      { element: 'H', xyz: [2.05, 1.80, -0.89] },
    ],
  },
  {
    name: 'Butyl',
    category: 'chain',
    formula: 'C₄H₉',
    connect_idx: 0,
    bond_length: 1.54,
    sites: [
      { element: 'C', xyz: [0, 0, 0] },
      { element: 'C', xyz: [1.54, 0, 0] },
      { element: 'C', xyz: [2.31, 1.26, 0] },
      { element: 'C', xyz: [3.85, 1.26, 0] },
      { element: 'H', xyz: [-0.51, 0.89, 0.36] },
      { element: 'H', xyz: [-0.51, -0.89, 0.36] },
      { element: 'H', xyz: [2.05, -0.89, 0.36] },
      { element: 'H', xyz: [2.05, -0.36, -0.89] },
      { element: 'H', xyz: [1.80, 2.15, 0.36] },
      { element: 'H', xyz: [1.80, 1.62, -0.89] },
      { element: 'H', xyz: [4.36, 0.37, -0.36] },
      { element: 'H', xyz: [4.36, 2.15, -0.36] },
      { element: 'H', xyz: [4.36, 1.26, 0.89] },
    ],
  },
  // ─── 官能团 (Functional groups) ───
  {
    name: 'Hydroxyl',
    category: 'functional',
    formula: 'OH',
    connect_idx: 0,
    bond_length: 1.43,
    sites: [
      { element: 'O', xyz: [0, 0, 0] },
      { element: 'H', xyz: [0.96, 0, 0] },
    ],
  },
  {
    name: 'Amino',
    category: 'functional',
    formula: 'NH₂',
    connect_idx: 0,
    bond_length: 1.47,
    sites: [
      { element: 'N', xyz: [0, 0, 0] },
      { element: 'H', xyz: [0.50, 0.87, 0] },
      { element: 'H', xyz: [0.50, -0.87, 0] },
    ],
  },
]
