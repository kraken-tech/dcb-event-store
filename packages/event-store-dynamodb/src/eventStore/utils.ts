import { Tags, DcbEvent, SequencedEvent, SequencePosition, Timestamp } from "@dcb-es/event-store"

const SEQ_PAD_LENGTH = 16
export const BUCKET_SIZE = 10_000

export const padSeqPos = (pos: number): string => pos.toString().padStart(SEQ_PAD_LENGTH, "0")

export type DynamoEventItem = {
    PK: string
    SK: string
    type: string
    tags: string[]
    data: Record<string, unknown>
    metadata: Record<string, unknown>
    timestamp: string
    seqPos: number
    batchId?: string
}

export type DynamoPointerItem = {
    PK: string
    SK: string
    seqPos: number
}

export type DynamoWriteBatch = {
    event: DynamoEventItem
    pointers: DynamoPointerItem[]
}

export const toSequencedEvent = (item: DynamoEventItem): SequencedEvent => ({
    position: SequencePosition.create(item.seqPos),
    timestamp: Timestamp.create(item.timestamp),
    event: {
        type: item.type,
        data: item.data,
        metadata: item.metadata,
        tags: Tags.from(item.tags)
    }
})

export const validateKeyComponent = (value: string, label: string): void => {
    if (value.includes("#")) {
        throw new Error(`${label} must not contain '#' (reserved as DynamoDB key delimiter): "${value}"`)
    }
}

export function chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size))
    }
    return chunks
}

export const buildWriteBatch = (event: DcbEvent, seqPos: number, batchId?: string): DynamoWriteBatch => {
    validateKeyComponent(event.type, "Event type")
    for (const tag of event.tags.values) {
        validateKeyComponent(tag, "Tag")
    }

    const timestamp = new Date().toISOString()
    const sk = padSeqPos(seqPos)
    const tags = [...event.tags.values]

    const eventItem: DynamoEventItem = {
        PK: `E#${seqPos}`,
        SK: "E",
        type: event.type,
        tags,
        data: event.data as Record<string, unknown>,
        metadata: event.metadata as Record<string, unknown>,
        timestamp,
        seqPos,
        ...(batchId ? { batchId } : {})
    }

    const pointers: DynamoPointerItem[] = [
        { PK: `IT#${event.type}`, SK: sk, seqPos },
        { PK: `A#${Math.floor(seqPos / BUCKET_SIZE)}`, SK: sk, seqPos }
    ]

    for (const tag of tags) {
        pointers.push({ PK: `I#${event.type}#${tag}`, SK: sk, seqPos })
        pointers.push({ PK: `IG#${tag}`, SK: sk, seqPos })
    }

    return { event: eventItem, pointers }
}
