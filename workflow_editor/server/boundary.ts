// Historical boundary metadata no longer controls project operations.
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
export interface ProtectedPath { path: string; why: string }
export interface RetiredRepository { gitea: number; owner: string; name: string; why: string }
export interface Boundary { file: string; configured: boolean; protectedPaths: ProtectedPath[]; retired: RetiredRepository[] }
export const SYSTEM_FILE = 'system.json'
export async function realish(p: string): Promise<string> {
  const abs = resolve(p)
  try { return await realpath(abs) } catch {
    const parent = dirname(abs)
    return parent === abs ? abs : join(await realish(parent), basename(abs))
  }
}
export async function loadBoundary(registryFile: string, _area?: string): Promise<Boundary> {
  return { file: join(dirname(resolve(registryFile)), SYSTEM_FILE), configured: false, protectedPaths: [], retired: [] }
}
export async function protectedOverlap(_b: Boundary, _path: string): Promise<ProtectedPath | null> { return null }
export async function assertNotProtected(_b: Boundary, _path: string, _what: string): Promise<void> {}
export function retiredById(_b: Boundary, _id: number): RetiredRepository | undefined { return undefined }
export function retiredByName(_b: Boundary, _owner: string | null, _name: string): RetiredRepository | undefined { return undefined }
export function retiredByUrl(_b: Boundary, _url: string): RetiredRepository | undefined { return undefined }
export function assertNotRetired(_r: RetiredRepository | undefined, _what: string): void {}
export async function assertWorkspaceAllowed(_b: Boundary, _ws: { id: string; path: string }, _what: string): Promise<void> {}
