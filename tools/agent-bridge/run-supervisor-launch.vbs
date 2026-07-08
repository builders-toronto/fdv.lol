' fdv.lol Hold runner supervisor — auto-launch at logon.
'
' Runs at every Windows logon. Launches the WSL-side supervisor
' (run-supervisor.sh) HIDDEN — no console window. The supervisor keeps the
' headless Hold runner (node cli.mjs --run-profile ...) alive, restarting it
' whenever it dies (crash, OS sleep, terminal hangup, OOM).
'
' Window mode 0 = hidden. bWaitOnReturn False = fire-and-forget.
'
' The supervisor's own single-instance guard (PIDFILE check) makes a second
' launch exit harmlessly, so running this when a supervisor is already up is
' safe.
'
' Managed by Claude. Repo copy + docs:
'   tools/agent-bridge/run-supervisor-launch.vbs
'   tools/agent-bridge/run-supervisor.sh
Set sh = CreateObject("WScript.Shell")
sh.Run "wsl.exe -d Ubuntu --exec bash /home/garys/.fdv-cowork/run-supervisor.sh", 0, False
