# UC Extension System - Testing Guide

This guide explains how to test the newly implemented Universal Connectivity (UC) extension infrastructure with the spreadsheet extension.

## What Was Implemented

### Phase 1: Core Extension Infrastructure ✅

1. **Extension Types** (`js-peer/src/lib/extension-types.ts`)
   - TypeScript interfaces for manifests, offers, commands, requests/responses

2. **Command Parser** (`js-peer/src/lib/command-parser.ts`)
   - Parses commands like `/sheet-show hackathon A1`
   - Validates command syntax

3. **Extension Manager** (`js-peer/src/lib/extension-manager.ts`)
   - Discovers extensions via gossipsub
   - Manages installation in localStorage
   - Tracks extension lifecycle

4. **Extension Protocol** (`js-peer/src/lib/extension-protocol.ts`)
   - Command execution via pubsub
   - Request/response pattern with timeout handling

5. **Extension Context** (`js-peer/src/context/extension-ctx.tsx`)
   - React context for extension state
   - Integrated into app provider chain

6. **Chat Integration** (`js-peer/src/components/chat.tsx`)
   - Detects `/` prefix commands
   - Executes commands via extension protocol
   - Shows responses inline in chat

7. **UI Components**
   - Extension Offer Banner (`js-peer/src/components/extension-offer-banner.tsx`)
   - Shows new extension offers with install/dismiss buttons

8. **Spreadsheet Extension Adapter** (`js-libp2p-examples/.../uc-extension-adapter.js`)
   - Announces spreadsheet extension on discovery topic
   - Handles commands: `show`, `write`, `list`
   - Integrates with Yjs spreadsheet engine

## How to Test

### Prerequisites

- Node.js installed
- Two terminal windows

### Step 1: Start the UC Chat

```bash
cd /Users/nandi/Documents/projekte/DecentraSol/universal-connectivity/js-peer
npm run dev
```

Navigate to: `http://localhost:3000/chat`

### Step 2: Start the Spreadsheet Extension

In a separate terminal:

```bash
cd /Users/nandi/js-libp2p-examples/examples/js-libp2p-example-yjs-libp2p
npm start
```

Navigate to: `http://localhost:5173`

- Click "Connect via WebRTC-Direct" or "Connect via WebSocket"
- Enter a topic name (e.g., "hackathon")

### Step 3: Wait for Extension Discovery

In the UC Chat window:
- After ~5-30 seconds, you should see a blue banner in the top-right
- The banner shows: "Collaborative Spreadsheet" extension offer
- Click **Install** to install the extension

### Step 4: Test Extension Commands

In the UC Chat input field, try these commands:

#### List available spreadsheet topics
```
/sheet-list
```

Expected response:
```json
✅ {
  "topics": ["hackathon"],
  "currentTopic": "hackathon"
}
```

#### Write a value to a cell
```
/sheet-write hackathon A1=25
```

Expected response:
```json
✅ {
  "topic": "hackathon",
  "cell": "A1",
  "value": 25,
  "formula": null
}
```

#### Show a cell value
```
/sheet-show hackathon A1
```

Expected response:
```json
✅ {
  "topic": "hackathon",
  "cell": "A1",
  "value": 25,
  "formula": null,
  "error": false
}
```

#### Write a formula
```
/sheet-write hackathon B1==A1*2
```

#### Show the calculated value
```
/sheet-show hackathon B1
```

Expected response:
```json
✅ {
  "topic": "hackathon",
  "cell": "B1",
  "value": 50,
  "formula": "=A1*2",
  "error": false
}
```

### Step 5: Verify Real-time Sync

1. In the spreadsheet UI (localhost:5173), manually edit cell A1 to a different value
2. In UC chat, run: `/sheet-show hackathon A1`
3. You should see the updated value

Alternatively:
1. In UC chat, write a value: `/sheet-write hackathon C3=hello`
2. In the spreadsheet UI, look at cell C3 - it should show "hello"

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    UC Chat (localhost:3000)                 │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ExtensionManager                                     │  │
│  │ - Subscribes to: universal-connectivity-extensions  │  │
│  │ - Receives extension offers                          │  │
│  │ - Stores installed extensions in localStorage       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ExtensionProtocol                                    │  │
│  │ - Publishes commands to: uc-ext-sheet-commands       │  │
│  │ - Listens for responses on same topic                │  │
│  │ - Timeout: 5s                                        │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Chat Component                                       │  │
│  │ - Detects `/` commands in input                      │  │
│  │ - Calls executeCommand()                             │  │
│  │ - Shows responses inline                             │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ gossipsub pubsub
                              │
┌─────────────────────────────────────────────────────────────┐
│             Spreadsheet Extension (localhost:5173)          │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ UCExtensionAdapter                                   │  │
│  │ - Publishes offers to: universal-connectivity-ext... │  │
│  │ - Subscribes to: uc-ext-sheet-commands               │  │
│  │ - Handles: show, write, list                         │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ SpreadsheetEngine (Yjs)                              │  │
│  │ - CRDT-based spreadsheet                             │  │
│  │ - Formulas, cell references                          │  │
│  │ - Real-time collaboration                            │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Topics Used

| Topic | Purpose |
|-------|---------|
| `universal-connectivity-extensions` | Extension discovery - spreadsheet publishes manifest here |
| `uc-ext-sheet-commands` | Extension commands - UC publishes commands, spreadsheet responds |
| `universal-connectivity` | Regular chat messages (existing) |
| `spreadsheet-1` (or custom) | Yjs document sync for spreadsheet data |

## Troubleshooting

### Extension offer doesn't appear

1. Check browser console in both UC and spreadsheet windows
2. Look for: `✅ UC Extension: Announced spreadsheet extension`
3. Verify gossipsub mesh is formed:
   - In UC console: Check for connected peers
   - In spreadsheet console: Check subscribed topics list

### Commands timeout

1. Verify spreadsheet is still running
2. Check topic name matches (e.g., "hackathon")
3. Look for `🎯 UC Extension: Received command:` in spreadsheet console
4. Verify both apps are connected to same gossipsub mesh

### Cell values don't sync

1. This is expected - commands operate on current spreadsheet state
2. Real-time sync works through Yjs, not through command protocol
3. To verify sync: manually edit in spreadsheet UI, then query via command

## LocalStorage

Installed extensions are stored in localStorage under key:
- `uc-installed-extensions`

To reset: Open browser DevTools → Application → Local Storage → Clear

## Future Enhancements (Plan 2)

- Custom libp2p protocol for request-response (more efficient)
- iframe embedding for extension UIs
- Streaming responses for large data
- Extension capabilities and permissions
- Context sharing (extensions reading chat history)
- Rich UI components (modals, sidebars)

## Files Modified/Created

### UC Chat (`/universal-connectivity/js-peer/`)
- `src/lib/extension-types.ts` (new)
- `src/lib/command-parser.ts` (new)
- `src/lib/extension-manager.ts` (new)
- `src/lib/extension-protocol.ts` (new)
- `src/lib/constants.ts` (modified)
- `src/context/extension-ctx.tsx` (new)
- `src/context/ctx.tsx` (modified)
- `src/components/chat.tsx` (modified)
- `src/components/extension-offer-banner.tsx` (new)
- `src/pages/chat.tsx` (modified)

### Spreadsheet Extension (`/js-libp2p-examples/.../js-libp2p-example-yjs-libp2p/`)
- `extension-manifest.json` (new)
- `uc-extension-adapter.js` (new)
- `index.js` (modified)

## Command Reference

| Command | Syntax | Description |
|---------|--------|-------------|
| `list` | `/sheet-list` | List all active spreadsheet topics |
| `show` | `/sheet-show <topic> <cell>` | Show value of a cell |
| `write` | `/sheet-write <topic> <cell>=<value>` | Write value or formula to cell |

### Examples

```bash
# Write values
/sheet-write hackathon A1=100
/sheet-write hackathon A2=200
/sheet-write hackathon B1=Hello

# Write formulas
/sheet-write hackathon A3==A1+A2
/sheet-write hackathon A4==A3*2

# Show values
/sheet-show hackathon A3  # Shows: 300
/sheet-show hackathon A4  # Shows: 600

# List topics
/sheet-list  # Shows: ["hackathon"]
```

## Development

To add new commands to the spreadsheet extension:

1. Update `extension-manifest.json` with new command definition
2. Add handler in `uc-extension-adapter.js` (e.g., `handleMyCommand()`)
3. Add case in `handleCommand()` switch statement
4. Test in UC chat: `/sheet-mycommand args`

## Questions?

See the plan document for detailed architecture decisions.
