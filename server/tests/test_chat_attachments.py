import base64

from catgo.routers.chat import ChatMessage, _anthropic_content, _ollama_message


def test_anthropic_content_translates_image_and_pdf_parts():
    image = base64.b64encode(b"png").decode()
    pdf = base64.b64encode(b"pdf").decode()
    blocks = _anthropic_content(
        [
            {"type": "text", "text": "inspect"},
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{image}"},
            },
            {
                "type": "file",
                "file": {
                    "filename": "paper.pdf",
                    "file_data": f"data:application/pdf;base64,{pdf}",
                },
            },
        ]
    )

    assert [block["type"] for block in blocks] == ["text", "image", "document"]
    assert blocks[1]["source"]["data"] == image
    assert blocks[2]["title"] == "paper.pdf"


def test_ollama_message_extracts_inline_image():
    image = base64.b64encode(b"png").decode()
    message = ChatMessage(
        role="user",
        content=[
            {"type": "text", "text": "inspect"},
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{image}"},
            },
        ],
    )

    assert _ollama_message(message) == {
        "role": "user",
        "content": "inspect",
        "images": [image],
    }
