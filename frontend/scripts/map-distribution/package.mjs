import { createArchive, verifyArchive } from './archive.mjs'
try {
  const args = process.argv.slice(2)
  if (args.length === 2 && args[0] === '--verify') console.log(await verifyArchive(args[1]))
  else if (!args.length) await createArchive()
  else throw new Error('Usage: npm run package:maps [-- --verify ARCHIVE.tar]')
} catch (error) { console.error(`Map packaging FAILED: ${error.message}`); process.exitCode = 1 }
