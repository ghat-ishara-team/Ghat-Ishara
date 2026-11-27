import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { createAccessRequestHandler } from '../_shared/access-request-handler.ts'

declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void }
Deno.serve(createAccessRequestHandler('verify', {
  env: name => Deno.env.get(name),
  createService: (url, key) => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }),
  defer: task => EdgeRuntime.waitUntil(task),
}))
