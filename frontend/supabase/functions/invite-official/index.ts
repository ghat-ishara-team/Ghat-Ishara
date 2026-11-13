import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { createInviteHandler } from './handler.ts'

Deno.serve(createInviteHandler({ createClient, env: (name) => Deno.env.get(name) }))
