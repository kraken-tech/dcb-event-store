import { Tags, DcbEvent, EventEnvelope, SequencePosition, Timestamp } from "@dcb-es/event-store"

const SEQ_PAD_LENGTH = 16

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

export const toEventEnvelope = (item: DynamoEventItem): EventEnvelope => ({
    sequencePosition: SequencePosition.create(item.seqPos),
    timestamp: Timestamp.create(item.timestamp),
    event: {
        type: item.type,
        data: item.data,
        metadata: item.metadata,
        tags: Tags.from(item.tags)
    }
})

export const toDynamoEventItems = (event: DcbEvent, seqPos: number, batchId?: string): DynamoEventItem[] => {
    const timestamp = new Date().toISOString()
    const sk = padSeqPos(seqPos)
    const tags = [...event.tags.values]

    const base = {
        type: event.type,
        tags,
        data: event.data as Record<string, unknown>,
        metadata: event.metadata as Record<string, unknown>,
        timestamp,
        seqPos,
        ...(batchId ? { batchId } : {})
    }

    const items: DynamoEventItem[] = [
        { PK: `E#${seqPos}`, SK: "E", ...base },
        { PK: `IT#${event.type}`, SK: sk, ...base },
        { PK: `A#${Math.floor(seqPos / 10000)}`, SK: sk, ...base }
    ]

    for (const tag of tags) {
        items.push({ PK: `I#${event.type}#${tag}`, SK: sk, ...base })
        items.push({ PK: `IG#${tag}`, SK: sk, ...base })
    }

    return items
}
