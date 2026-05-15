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
