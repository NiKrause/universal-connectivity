import { ParsedCommand } from './extension-types'

/**
 * Check if input string is a command (starts with /)
 */
export function isCommand(input: string): boolean {
  return input.trim().startsWith('/')
}

/**
 * Parse command string into structured command object
 * 
 * Examples:
 * - "/sheet-show hackathon A1" -> {extensionId: "sheet", command: "show", args: ["hackathon", "A1"]}
 * - "/sheet-write hackathon A1=25" -> {extensionId: "sheet", command: "write", args: ["hackathon", "A1=25"]}
 * - "/sheet-list" -> {extensionId: "sheet", command: "list", args: []}
 * 
 * @param input Command string from chat input
 * @returns Parsed command object or null if invalid
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim()
  
  if (!isCommand(trimmed)) {
    return null
  }

  // Remove leading /
  const withoutSlash = trimmed.substring(1)
  
  // Split by whitespace
  const parts = withoutSlash.split(/\s+/)
  
  if (parts.length === 0) {
    return null
  }

  // First part should be "extensionId-command"
  const [firstPart, ...args] = parts
  const dashIndex = firstPart.indexOf('-')
  
  if (dashIndex === -1) {
    // No dash found, treat entire first part as extension with implicit command
    return {
      extensionId: firstPart,
      command: 'default',
      args,
      raw: input
    }
  }

  const extensionId = firstPart.substring(0, dashIndex)
  const command = firstPart.substring(dashIndex + 1)

  return {
    extensionId,
    command,
    args,
    raw: input
  }
}

/**
 * Validate that a parsed command has required fields
 */
export function isValidCommand(parsed: ParsedCommand | null): parsed is ParsedCommand {
  return parsed !== null && 
         parsed.extensionId.length > 0 && 
         parsed.command.length > 0
}
