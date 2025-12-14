import { useLibp2pContext } from '@/context/ctx'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { CHAT_FILE_TOPIC, CHAT_TOPIC } from '@/lib/constants'
import { createIcon } from '@download/blockies'
import { ChatFile, ChatMessage, useChatContext } from '../context/chat-ctx'
import { v4 as uuidv4 } from 'uuid';
import { useExtensionContext } from '@/context/extension-ctx'
import { isCommand, parseCommand, isValidCommand } from '@/lib/command-parser'
import InstalledExtensions from './installed-extensions'
import { ChatPeerList } from './chat-peer-list'
import { peerIdFromString } from '@libp2p/peer-id'

interface MessageProps extends ChatMessage { }

function Message({ msg, fileObjectUrl, from, peerId }: MessageProps) {
  const msgref = React.useRef<HTMLLIElement>(null)
  const { libp2p } = useLibp2pContext()


  useEffect(() => {
    const icon = createIcon({
      seed: peerId,
      size: 15,
      scale: 3,
    })
    icon.className = 'rounded mr-2 max-h-10 max-w-10'
    const childrenCount = msgref.current?.childElementCount
    // Prevent inserting an icon more than once.
    if (childrenCount && childrenCount < 2) {
      msgref.current?.insertBefore(icon, msgref.current?.firstChild)
    }
  }, [peerId])

  return (
    <li ref={msgref} className={`flex ${from === 'me' ? 'justify-end' : 'justify-start'}`}>
      <div

        className="flex relative max-w-xl px-4 py-2 text-gray-700 rounded shadow bg-white"
      >
        <div className="block whitespace-pre-wrap">
          {msg}
          <p>{fileObjectUrl ? <a href={fileObjectUrl} target="_blank"><b>Download</b></a> : ""}</p>
          <p className="italic text-gray-400">{peerId !== libp2p.peerId.toString() ? `from: ${peerId.slice(-4)}` : null} </p>
        </div>
      </div>
    </li>
  )
}

export default function ChatContainer() {
  const { libp2p } = useLibp2pContext()
  const { messageHistory, setMessageHistory, files, setFiles, roomId, setRoomId, directMessages, setDirectMessages } = useChatContext();
  const { executeCommand, isInstalled } = useExtensionContext();
  const [input, setInput] = useState<string>('')
  const fileRef = useRef<HTMLInputElement>(null);
  
  const isPrivateChat = roomId !== ''
  const privateMessages = isPrivateChat ? (directMessages[roomId] || []) : []

  // Handle extension icon click - send help command
  const handleExtensionClick = useCallback(async (extensionId: string) => {
    const helpCommand = `/${extensionId}-help`
    const myPeerId = libp2p.peerId.toString()

    // Show command in chat
    setMessageHistory(prev => [...prev, {
      msgId: uuidv4(),
      msg: helpCommand,
      fileObjectUrl: undefined,
      from: 'me',
      peerId: myPeerId,
      read: false,
      receivedAt: Date.now(),
    }])

    // Execute help command
    try {
      const response = await executeCommand(extensionId, 'help', [])
      
      let responseMsg: string
      if (response.success) {
        if (response.data?.help) {
          responseMsg = `✅\n${response.data.help}`
        } else {
          responseMsg = `✅ ${JSON.stringify(response.data, null, 2)}`
        }
      } else {
        responseMsg = `❌ Error: ${response.error}`
      }
      
      setMessageHistory(prev => [...prev, {
        msgId: uuidv4(),
        msg: responseMsg,
        fileObjectUrl: undefined,
        from: 'extension',
        peerId: extensionId,
        read: false,
        receivedAt: Date.now(),
      }])
    } catch (error: any) {
      setMessageHistory(prev => [...prev, {
        msgId: uuidv4(),
        msg: `❌ Command failed: ${error.message}`,
        fileObjectUrl: undefined,
        from: 'system',
        peerId: 'system',
        read: false,
        receivedAt: Date.now(),
      }])
    }
  }, [libp2p, setMessageHistory, executeCommand])

  const sendMessage = useCallback(async () => {
    if (input === '') return

    const myPeerId = libp2p.peerId.toString()

    // Check if input is an extension command
    if (isCommand(input)) {
      const parsed = parseCommand(input)
      
      if (!isValidCommand(parsed)) {
        // Show error message in chat
        setMessageHistory([...messageHistory, {
          msgId: uuidv4(),
          msg: `❌ Invalid command syntax. Commands should be like: /extension-command args`,
          fileObjectUrl: undefined,
          from: 'system',
          peerId: 'system',
          read: false,
          receivedAt: Date.now(),
        }])
        setInput('')
        return
      }

      // Check if extension is installed
      if (!isInstalled(parsed.extensionId)) {
        setMessageHistory([...messageHistory, {
          msgId: uuidv4(),
          msg: `❌ Extension '${parsed.extensionId}' is not installed`,
          fileObjectUrl: undefined,
          from: 'system',
          peerId: 'system',
          read: false,
          receivedAt: Date.now(),
        }])
        setInput('')
        return
      }

      // Show command in chat
      setMessageHistory([...messageHistory, {
        msgId: uuidv4(),
        msg: input,
        fileObjectUrl: undefined,
        from: 'me',
        peerId: myPeerId,
        read: false,
        receivedAt: Date.now(),
      }])

      // Execute command
      try {
        const response = await executeCommand(parsed.extensionId, parsed.command, parsed.args)
        
        // Show response in chat
        let responseMsg: string
        if (response.success) {
          // Check if response has a help field (for help commands)
          if (response.data?.help) {
            responseMsg = `✅\n${response.data.help}`
          } else {
            responseMsg = `✅ ${JSON.stringify(response.data, null, 2)}`
          }
        } else {
          responseMsg = `❌ Error: ${response.error}`
        }
        
        setMessageHistory(prev => [...prev, {
          msgId: uuidv4(),
          msg: responseMsg,
          fileObjectUrl: undefined,
          from: 'extension',
          peerId: parsed.extensionId,
          read: false,
          receivedAt: Date.now(),
        }])
      } catch (error: any) {
        setMessageHistory(prev => [...prev, {
          msgId: uuidv4(),
          msg: `❌ Command failed: ${error.message}`,
          fileObjectUrl: undefined,
          from: 'system',
          peerId: 'system',
          read: false,
          receivedAt: Date.now(),
        }])
      }
      
      setInput('')
      return
    }

    // Private or group chat message
    if (isPrivateChat) {
      // Send direct message
      try {
        const targetPeerId = peerIdFromString(roomId)
        await libp2p.services.directMessage.send(targetPeerId, input)
        
        // Add to direct messages
        const newMsg: ChatMessage = {
          msgId: uuidv4(),
          msg: input,
          fileObjectUrl: undefined,
          from: 'me',
          peerId: myPeerId,
          read: false,
          receivedAt: Date.now(),
        }
        
        setDirectMessages(prev => ({
          ...prev,
          [roomId]: [...(prev[roomId] || []), newMsg]
        }))
        
        setInput('')
      } catch (error: any) {
        console.error('Failed to send direct message:', error)
        alert(`Failed to send message: ${error.message}`)
      }
    } else {
      // Group chat message
      console.log(
        `peers in gossip for topic ${CHAT_TOPIC}:`,
        libp2p.services.pubsub.getSubscribers(CHAT_TOPIC).toString(),
      )

      const res = await libp2p.services.pubsub.publish(
        CHAT_TOPIC,
        new TextEncoder().encode(input),
      )
      console.log(
        'sent message to: ',
        res.recipients.map((peerId) => peerId.toString()),
      )

      setMessageHistory([...messageHistory, { msgId: uuidv4(), msg: input, fileObjectUrl: undefined, from: 'me', peerId: myPeerId, read: false, receivedAt: Date.now() }])
      setInput('')
    }
  }, [input, messageHistory, setInput, libp2p, setMessageHistory, executeCommand, isInstalled, isPrivateChat, roomId, setDirectMessages])

  const sendFile = useCallback(async (readerEvent: ProgressEvent<FileReader>) => {
    const fileBody = readerEvent.target?.result as ArrayBuffer;

    const myPeerId = libp2p.peerId.toString()
    const file: ChatFile = {
      id: uuidv4(),
      body: new Uint8Array(fileBody),
      sender: myPeerId,
    }
    setFiles(files.set(file.id, file))

    console.log(
      `peers in gossip for topic ${CHAT_FILE_TOPIC}:`,
      libp2p.services.pubsub.getSubscribers(CHAT_FILE_TOPIC).toString(),
    )

    const res = await libp2p.services.pubsub.publish(
      CHAT_FILE_TOPIC,
      new TextEncoder().encode(file.id)
    )
    console.log(
      'sent file to: ',
      res.recipients.map((peerId) => peerId.toString()),
    )

    const msg: ChatMessage = {
      msgId: uuidv4(),
      msg: newChatFileMessage(file.id, file.body),
      fileObjectUrl: window.URL.createObjectURL(new Blob([file.body])),
      from: 'me',
      peerId: myPeerId,
      read: false,
      receivedAt: Date.now(),
    }
    setMessageHistory([...messageHistory, msg])
  }, [messageHistory, libp2p, setMessageHistory, files, setFiles])

  const newChatFileMessage = (id: string, body: Uint8Array) => {
    return `File: ${id} (${body.length} bytes)`
  }

  const handleKeyUp = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') {
        return
      }
      sendMessage()
    },
    [sendMessage],
  )

  const handleSend = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      sendMessage()
    },
    [sendMessage],
  )

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setInput(e.target.value)
    },
    [setInput],
  )

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        const reader = new FileReader();
        reader.readAsArrayBuffer(e.target.files[0]);
        reader.onload = (readerEvent) => {
          sendFile(readerEvent)
        };
      }
    },
    [sendFile],
  )

  const handleFileSend = useCallback(
    async (_e: React.MouseEvent<HTMLButtonElement>) => {
      fileRef?.current?.click();
    },
    [fileRef],
  )

  return (
    <div className="container mx-auto">
      <div className="min-w-full border rounded lg:grid lg:grid-cols-3">
        <div className="lg:col-span-2 lg:block">
          <div className="w-full">
            <div className={`relative flex items-center p-3 border-b border-gray-300 ${isPrivateChat ? 'bg-green-50 border-green-200' : ''}`}>
              {isPrivateChat && (
                <button
                  onClick={() => setRoomId('')}
                  className="mr-2 text-gray-600 hover:text-gray-900 text-xl"
                  title="Back to public chat"
                >
                  ←
                </button>
              )}
              <span className="text-3xl">{isPrivateChat ? '🔐' : '💁🏽‍♀️💁🏿‍♂️'}</span>
              <span className="block ml-2 font-bold text-gray-600">
                {isPrivateChat ? `Private: ${roomId.slice(0, 8)}...${roomId.slice(-4)}` : 'Public Chat'}
              </span>
              {!isPrivateChat && <InstalledExtensions onExtensionClick={handleExtensionClick} />}
            </div>
            <div className="relative w-full flex flex-col-reverse p-6 overflow-y-auto h-[40rem] bg-gray-100">
              <ul className="space-y-2">
                {/* messages start */}
                {isPrivateChat
                  ? privateMessages.map((message, idx) => (
                      <Message key={idx} {...message} />
                    ))
                  : messageHistory.map((message, idx) => (
                      <Message key={idx} {...message} />
                    ))}
                {/* messages end */}
              </ul>
            </div>

            <div className="flex items-center justify-between w-full p-3 border-t border-gray-300">
              <button>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-6 h-6 text-gray-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              </button>

              <input ref={fileRef} className="hidden" type="file" onChange={handleFileInput} />
              <button onClick={handleFileSend}>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-5 h-5 text-gray-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
                  />
                </svg>
              </button>

              <input
                value={input}
                onKeyUp={handleKeyUp}
                onChange={handleInput}
                type="text"
                placeholder="Message"
                className="block w-full py-2 pl-4 mx-3 bg-gray-100 rounded-full outline-none focus:text-gray-700"
                name="message"
                required
              />
              <button>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-5 h-5 text-gray-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                  />
                </svg>
              </button>
              <button onClick={handleSend} type="submit">
                <svg
                  className="w-5 h-5 text-gray-500 origin-center transform rotate-90"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <ChatPeerList />
      </div>
    </div>
  )
}

export function RoomList() {
  return (
    <div className="border-r border-gray-300 lg:col-span-1">
      <div className="mx-3 my-3">
        <div className="relative text-gray-600">
          <span className="absolute inset-y-0 left-0 flex items-center pl-2">
            <svg
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              className="w-6 h-6 text-gray-300"
            >
              <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
            </svg>
          </span>
          <input
            type="search"
            className="block w-full py-2 pl-10 bg-gray-100 rounded outline-none"
            name="search"
            placeholder="Search"
            required
          />
        </div>
      </div>

      <ul className="overflow-auto h-[32rem]">
        <h2 className="my-2 mb-2 ml-2 text-lg text-gray-600">Chats</h2>
        <li>
          <a className="flex items-center px-3 py-2 text-sm transition duration-150 ease-in-out border-b border-gray-300 cursor-pointer hover:bg-gray-100 focus:outline-none">
            <img
              className="object-cover w-10 h-10 rounded-full"
              src="https://github.com/2color.png"
              alt="username"
            />
            <div className="w-full pb-2">
              <div className="flex justify-between">
                <span className="block ml-2 font-semibold text-gray-600">
                  Daniel
                </span>
                <span className="block ml-2 text-sm text-gray-600">
                  25 minutes
                </span>
              </div>
              <span className="block ml-2 text-sm text-gray-600">bye</span>
            </div>
          </a>
          <a className="flex items-center px-3 py-2 text-sm transition duration-150 ease-in-out bg-gray-100 border-b border-gray-300 cursor-pointer focus:outline-none">
            <img
              className="object-cover w-10 h-10 rounded-full"
              src="https://github.com/achingbrain.png"
              alt="username"
            />
            <div className="w-full pb-2">
              <div className="flex justify-between">
                <span className="block ml-2 font-semibold text-gray-600">
                  Alex
                </span>
                <span className="block ml-2 text-sm text-gray-600">
                  50 minutes
                </span>
              </div>
              <span className="block ml-2 text-sm text-gray-600">
                Good night
              </span>
            </div>
          </a>
          <a className="flex items-center px-3 py-2 text-sm transition duration-150 ease-in-out border-b border-gray-300 cursor-pointer hover:bg-gray-100 focus:outline-none">
            <img
              className="object-cover w-10 h-10 rounded-full"
              src="https://github.com/hannahhoward.png"
              alt="username"
            />
            <div className="w-full pb-2">
              <div className="flex justify-between">
                <span className="block ml-2 font-semibold text-gray-600">
                  Hannah
                </span>
                <span className="block ml-2 text-sm text-gray-600">6 hour</span>
              </div>
              <span className="block ml-2 text-sm text-gray-600">
                Good Morning
              </span>
            </div>
          </a>
        </li>
      </ul>
    </div>
  )
}
