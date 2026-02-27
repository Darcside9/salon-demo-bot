# WhatsApp Admin Commands

Only **whitelisted admin numbers** can use these commands. Manage the whitelist from the Dashboard → Whitelist tab.

## Safe Operational Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/status` | Bot status, salon info, usage stats |
| `/enable` | Enable automation |
| `/disable` | Disable automation (bot goes silent) |
| `/takeover` | Switch current chat to human mode |
| `/resume` | Resume bot automation for current chat |
| `/reload` | Reload active config from Supabase |

## Website Import Commands

| Command | Description |
|---------|-------------|
| `/import <url>` | Fetch website and generate draft config proposal |
| `/approve` | Activate the latest draft config |
| `/rollback <version>` | Rollback to a specific config version |

## Dashboard-Only Actions
The following **cannot** be done via WhatsApp commands:
- View/edit SOUL.md or FAQ
- Manage admin whitelist
- Switch salon profiles
- Change model settings or secrets
