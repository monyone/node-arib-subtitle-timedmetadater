#!/usr/bin/env node

import { TSPacket } from 'arib-mpeg2ts-parser';
import { TSPES } from 'arib-mpeg2ts-parser';

export default class ID3 {
  static metadata_pointer_descriptor (program_number: number) {
    const metadata_pointer_descriptor_application_format = Buffer.from([0xFF, 0xFF])
    const metadata_pointer_descriptor_application_format_identifier = Buffer.from([
      0x49, 0x44, 0x33, 0x20, // ID3
    ]);
    const metadata_pointer_descriptor_format = Buffer.from([0xFF]);
    const metadata_pointer_descriptor_format_identifier = Buffer.from([
      0x49, 0x44, 0x33, 0x20 // ID3
    ]);
    const metadata_pointer_descriptor_flags = Buffer.from([
      0x00, 0x1F // metadata_service_id + other flags
    ]);
    const metadata_pointer_descriptor_program_number = Buffer.from([
      ((program_number & 0xFF00) >> 8), ((program_number & 0x00FF) >> 0)
    ]);

    const metadata_descriptor_payload =  Buffer.concat([
      metadata_pointer_descriptor_application_format,
      metadata_pointer_descriptor_application_format_identifier,
      metadata_pointer_descriptor_format,
      metadata_pointer_descriptor_format_identifier,
      metadata_pointer_descriptor_flags,
      metadata_pointer_descriptor_program_number,
    ]);

    const metadata_descriptor_length = Buffer.from([metadata_descriptor_payload.length]);
    const metadata_descriptor_tag = Buffer.from([0x26]);

    return Buffer.concat([
      metadata_descriptor_tag,
      metadata_descriptor_length,
      metadata_descriptor_payload,
    ]);
  }
  
  static metadata_descriptor () {
    const metadata_descriptor_application_format = Buffer.from([0xFF, 0xFF]);
    const metadata_descriptor_application_format_identifier = Buffer.from([
      0x49, 0x44, 0x33, 0x20, // ID3
    ]);
    const metadata_descriptor_format = Buffer.from([0xFF]);
    const metadata_descriptor_format_identifier = Buffer.from([
      0x49, 0x44, 0x33, 0x20, // ID3
    ]);
    const metadata_descriptor_flags = Buffer.from([
      0xFF, 0x0F, // metadata_service_id + other flags
    ]);

    const metadata_descriptor_payload = Buffer.concat([
      metadata_descriptor_application_format,
      metadata_descriptor_application_format_identifier,
      metadata_descriptor_format,
      metadata_descriptor_format_identifier,
      metadata_descriptor_flags,
    ]);

    const metadata_descriptor_length = Buffer.from([metadata_descriptor_payload.length]);
    const metadata_descriptor_tag = Buffer.from([0x26]);

    return Buffer.concat([
      metadata_descriptor_tag,
      metadata_descriptor_length,
      metadata_descriptor_payload,
    ])
  }

  static metadata_elementary_stream (PID: number) {
    const descriptor = this.metadata_descriptor();
    const ES_info_length = Buffer.from([
      ((descriptor.length & 0xFF00) >> 8), ((descriptor.length & 0x00FF) >> 0),
    ]);
    const elementary_PID = Buffer.from([
      ((PID & 0x1F00) >> 8), ((PID & 0x00FF) >> 0),
    ]);
    const stream_type = Buffer.from([0x15]);

    return Buffer.concat([
      stream_type,
      elementary_PID,
      ES_info_length,
      descriptor,
    ]);
  }

  static ID3v2TXXX (text: string) {
    const txxx_payload = Buffer.concat([
      Buffer.from([0x03, 0x00]),
      Buffer.from(text),
      Buffer.from([0x00]),
    ]);
    const txxx_paylaod_size = Buffer.from([
      ((txxx_payload.length & 0xFE00000) >> 21),
      ((txxx_payload.length & 0x01FC000) >> 14),
      ((txxx_payload.length & 0x0003F80) >>  7),
      ((txxx_payload.length & 0x000007F) >>  0),
    ]);
    const txxx_frame = Buffer.concat([
      Buffer.from([0x54, 0x58, 0x58, 0x58]),
      txxx_paylaod_size,
      Buffer.from([0x00, 0x00]),
      txxx_payload,
    ]);
    const txxx_frame_size = Buffer.from([
      ((txxx_frame.length & 0xFE00000) >> 21),
      ((txxx_frame.length & 0x01FC000) >> 14),
      ((txxx_frame.length & 0x0003F80) >>  7),
      ((txxx_frame.length & 0x000007F) >>  0),
    ]);

    return Buffer.concat([
      Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]),
      txxx_frame_size,
      txxx_frame,
    ]);
  }

  static timedmetadata (pts: number, text: string) {
    const header = Buffer.from([
      0x00, 0x00, 0x01, 0xbd, // +2 bytes
    ]);
    const flags = Buffer.from([
      0x84, 0x80, // (10, 00, 0, 0, 0, 0), (10 (PTS only), 0, 0, 0, 0, 0, 0, 0) +1 byte
    ]);
    const PTS = Buffer.from([
      ((2 << 4) | (((pts & 0x1C0000000) >> 30) << 1) | 1),
      ((((pts & 0x3FFF8000) >> 15) << 1) & 0xFF00) >> 8,
      ((((pts & 0x3FFF8000) >> 15) << 1) & 0x00FF) | 1,
      ((((pts & 0x7F00) >> 0) << 1) & 0xFF00) >> 8,
      ((((pts & 0x00FF) >> 0) << 1) & 0x00FF) | 1,
    ]);

    const id3 = this.ID3v2TXXX(text);
    // TSPES.PES_HEADER_SIZE + flags + PES_header_data_length + PTS + payload
    const without_padding_length = TSPES.PES_HEADER_SIZE + 2 + 1 + 5 + id3.length;
    const packet_payload_size = (TSPacket.PACKET_SIZE - TSPacket.HEADER_SIZE);
    const PES_header_data_length = packet_payload_size - (without_padding_length % packet_payload_size);

    const payload = Buffer.concat([
      flags,
      Buffer.from([PES_header_data_length]),
      PTS,
      Buffer.alloc(PES_header_data_length, 0xFF),
      id3,
    ]);

    return Buffer.concat([
      header,
      Buffer.from([
        ((payload.length & 0xFF00) >> 8), ((payload.length & 0x00FF) >> 0),
      ]),
      payload
    ]);
  }
}