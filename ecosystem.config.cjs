/**
 * pm2 configuration.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup        # survive a reboot
 *
 * Committed rather than typed on the server, because a hand-written pm2 entry
 * is how this deployment ended up pointing at `dist/index.js` — a path that has
 * never existed here. There is no build step: this is plain JavaScript and
 * `src/index.js` is the program.
 *
 * .cjs, not .js: package.json says "type": "module", and pm2 reads its config
 * with require().
 */
module.exports = {
  apps: [
    {
      name: 'mastipe-api',
      script: 'src/index.js',
      cwd: __dirname,

      /**
       * ONE instance. This is a correctness constraint, not a capacity choice.
       *
       * Live board updates are held in each process's memory — see broadcast()
       * in src/services/live.service.js. Under pm2 cluster mode a player's
       * browser connects to one worker while the worker that draws the number
       * is a different one, so numbers would silently stop arriving for most
       * of the table. The draw scheduler itself is safe across processes
       * (FOR UPDATE SKIP LOCKED); the live stream is not.
       *
       * Raising this needs LISTEN/NOTIFY behind that one function first.
       */
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      // A tight restart loop on a boot failure buries the real error under
      // thousands of identical lines. Ten tries, backing off, then it stays
      // down and waits to be looked at.
      max_restarts: 10,
      restart_delay: 4000,
      min_uptime: '30s',

      /**
       * Time to finish shutting down.
       *
       * The app closes its live connections and stops the scheduler on SIGTERM.
       * pm2's default 1.6s can cut that short mid-draw; 10s is comfortable and
       * costs nothing on a healthy stop.
       */
      kill_timeout: 10000,

      // A leak shows up as a slow climb. Restarting at 500MB turns a night-time
      // outage into a blip nobody notices.
      max_memory_restart: '500M',

      env: {
        NODE_ENV: 'production',
      },

      // The app writes its own timestamps, so pm2 must not add a second set.
      time: false,
      merge_logs: true,
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',

      // .env is read by the app itself (dotenv), so nothing is duplicated here.
      // Keeping credentials out of this file is why it can be committed.
    },
  ],
};
