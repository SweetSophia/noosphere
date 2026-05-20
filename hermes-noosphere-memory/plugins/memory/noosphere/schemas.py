"""Tool schemas for the Hermes Noosphere memory provider."""

NOOSPHERE_STATUS_SCHEMA = {
    "name": "noosphere_status",
    "description": (
        "Check Noosphere memory provider connectivity and status. Use this when "
        "the user asks whether Noosphere memory is configured or available."
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
}

NOOSPHERE_RECALL_SCHEMA = {
    "name": "noosphere_recall",
    "description": "Search Noosphere durable memory for relevant context.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query for durable memory.",
            },
            "resultCap": {
                "type": "integer",
                "description": "Maximum results to return, 1 to 20.",
            },
            "tokenBudget": {
                "type": "integer",
                "description": "Maximum prompt-token budget for formatted recall context.",
            },
            "scope": {
                "type": "string",
                "description": "Optional Noosphere scope hint.",
            },
        },
        "required": ["query"],
        "additionalProperties": False,
    },
}

NOOSPHERE_GET_SCHEMA = {
    "name": "noosphere_get",
    "description": "Fetch one normalized Noosphere memory result by canonical reference or provider/id.",
    "parameters": {
        "type": "object",
        "properties": {
            "canonicalRef": {
                "type": "string",
                "description": "Canonical memory reference, for example noosphere:article:<id>.",
            },
            "provider": {
                "type": "string",
                "description": "Provider id when fetching by provider-local id.",
            },
            "id": {
                "type": "string",
                "description": "Provider-local memory id.",
            },
        },
        "additionalProperties": False,
    },
}

NOOSPHERE_TOPICS_SCHEMA = {
    "name": "noosphere_topics",
    "description": "List Noosphere topics for choosing where durable memory should be saved later.",
    "parameters": {
        "type": "object",
        "properties": {},
        "additionalProperties": False,
    },
}

NOOSPHERE_SAVE_SCHEMA = {
    "name": "noosphere_save",
    "description": (
        "Save durable, reusable knowledge to Noosphere as a draft memory candidate. "
        "Use only for information likely to matter in future sessions."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Short title for the memory candidate."},
            "content": {"type": "string", "description": "Durable memory content to save."},
            "topicId": {
                "type": "string",
                "description": "Noosphere topic id. Uses configured default topic_id if omitted.",
            },
            "excerpt": {"type": "string", "description": "Optional short summary."},
            "tags": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional tags.",
            },
            "restrictedTags": {
                "type": "array",
                "items": {"type": "string", "minLength": 1, "maxLength": 64},
                "maxItems": 16,
                "description": (
                    "Optional Noosphere restricted scope tags. The server rejects "
                    "scopes not allowed for the API key."
                ),
            },
            "source": {"type": "string", "description": "Optional source pointer."},
            "confidence": {
                "type": "string",
                "enum": ["low", "medium", "high"],
                "description": "Initial confidence for the draft candidate.",
            },
        },
        "required": ["title", "content"],
        "additionalProperties": False,
    },
}

TOOL_SCHEMAS = [
    NOOSPHERE_STATUS_SCHEMA,
    NOOSPHERE_RECALL_SCHEMA,
    NOOSPHERE_GET_SCHEMA,
    NOOSPHERE_TOPICS_SCHEMA,
    NOOSPHERE_SAVE_SCHEMA,
]
