// flue-blueprint: channel/telegram@1
import {
	createTelegramChannel,
	type TelegramConversationRef,
} from '@flue/telegram';
import { dispatch } from '@flue/runtime';
import { Api } from 'grammy';
import type { Message } from 'grammy/types';
import { Assistant } from '../agents/assistant.ts';

export const client = new Api(process.env.TELEGRAM_BOT_TOKEN!);

// Only this Telegram chat may create agent conversations. Group ids arrive
// in -100<base> or -<base> form; the matcher accepts every form of the base.
const ALLOWED_CHAT_BASE = '6670410520';
function isAllowedChat(chatId: number): boolean {
	const digits = String(Math.abs(chatId));
	return (
		digits === ALLOWED_CHAT_BASE ||
		(digits.startsWith('100') && digits.slice(3) === ALLOWED_CHAT_BASE)
	);
}

export const channel = createTelegramChannel({
	secretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,

	// Path: /channels/telegram/webhook
	async webhook({ update }) {
		const incoming =
			update.message ?? update.channel_post ?? update.business_message;
		if (incoming) {
			if (!isAllowedChat(incoming.chat.id)) return;
			const conversation = conversationFromMessage(incoming);
			await dispatch(Assistant, {
				id: channel.instanceId(conversation),
				// Recorded once when this event creates the instance; ignored after.
				initialData: conversationData(conversation, incoming),
				message: {
					kind: 'signal',
					type: 'telegram.message',
					body: messageBody(incoming),
					attributes: { updateId: String(update.update_id) },
				},
			});
			return;
		}

		if (update.callback_query) {
			const query = update.callback_query;
			await client.answerCallbackQuery(query.id);
			if (!query.message) return;
			if (!isAllowedChat(query.message.chat.id)) return;
			const conversation = conversationFromMessage(query.message);
			await dispatch(Assistant, {
				id: channel.instanceId(conversation),
				// Recorded once when this event creates the instance; ignored after.
				initialData: conversationData(conversation, query.message),
				message: {
					kind: 'signal',
					type: 'telegram.callback_query',
					body: query.data ?? '',
					attributes: {
						updateId: String(update.update_id),
						fromId: String(query.from.id),
						...(query.from.username === undefined
							? {}
							: { fromUsername: query.from.username }),
					},
				},
			});
			return;
		}
	},
});

// Message text, or a short placeholder describing a media-only message.
function messageBody(message: Message): string {
	if (message.text !== undefined) return message.text;
	if (message.caption !== undefined) return message.caption;
	if (message.photo) return '[photo message]';
	if (message.video) return '[video message]';
	if (message.voice) return '[voice message]';
	if (message.document) return '[document message]';
	if (message.sticker) return '[sticker message]';
	return '[non-text message]';
}

// Build the canonical destination identity from a native Telegram Message.
function conversationFromMessage(message: Message): TelegramConversationRef {
	const topic = {
		...(message.message_thread_id === undefined
			? {}
			: { messageThreadId: message.message_thread_id }),
		...(message.direct_messages_topic?.topic_id === undefined
			? {}
			: { directMessagesTopicId: message.direct_messages_topic.topic_id }),
	};
	return message.business_connection_id
		? {
				type: 'business-chat',
				businessConnectionId: message.business_connection_id,
				chatId: message.chat.id,
				...topic,
			}
		: { type: 'chat', chatId: message.chat.id, ...topic };
}

// Instance-creation data: the destination ref plus small instance-constant context.
function conversationData(
	conversation: TelegramConversationRef,
	message: Message,
) {
	return {
		type: conversation.type,
		chatId: conversation.chatId,
		...(conversation.type === 'business-chat'
			? { businessConnectionId: conversation.businessConnectionId }
			: {}),
		...(conversation.messageThreadId === undefined
			? {}
			: { messageThreadId: conversation.messageThreadId }),
		...(conversation.directMessagesTopicId === undefined
			? {}
			: { directMessagesTopicId: conversation.directMessagesTopicId }),
		...(message.chat.title === undefined
			? {}
			: { chatTitle: message.chat.title }),
	};
}

export interface TelegramDestination {
	type: 'chat' | 'business-chat';
	chatId: number;
	businessConnectionId?: string;
	messageThreadId?: number;
	directMessagesTopicId?: number;
}

export async function sendTelegramText(
	destination: TelegramDestination,
	text: string,
): Promise<number> {
	const message = await client.sendMessage(destination.chatId, text, {
		...(destination.type === 'business-chat' && destination.businessConnectionId
			? { business_connection_id: destination.businessConnectionId }
			: {}),
		...(destination.messageThreadId
			? { message_thread_id: destination.messageThreadId }
			: {}),
		...(destination.directMessagesTopicId
			? { direct_messages_topic_id: destination.directMessagesTopicId }
			: {}),
	});
	return message.message_id;
}
