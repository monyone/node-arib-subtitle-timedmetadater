#!/usr/bin/env node

import { Transform, TransformCallback } from 'stream'

import { TSPacket, TSPacketQueue } from 'arib-mpeg2ts-parser';
import { TSSection, TSSectionQueue, TSSectionPacketizer } from 'arib-mpeg2ts-parser';
import { TSPES, TSPESQueue } from 'arib-mpeg2ts-parser';

import ID3 from './id3'

export default class MetadataTransform extends Transform {
  private packetQueue = new TSPacketQueue();

  private PAT_TSSectionQueue = new TSSectionQueue();

  private PMT_TSSectionQueues = new Map<number, TSSectionQueue>();
  private PMT_ContinuityCounters = new Map<number, number>();

  private Metadata_TSPESQueues = new Map<number, TSPESQueue>();
  private Metadata_ContinuityCounters = new Map<number, number>();

  _transform (chunk: Buffer, encoding: string, callback: TransformCallback): void {
    this.packetQueue.push(chunk);
    while (!this.packetQueue.isEmpty()) {
      const packet = this.packetQueue.pop()!;

      const pid = TSPacket.pid(packet);

      if (pid == 0x00) {
        this.PAT_TSSectionQueue.push(packet)
        while (!this.PAT_TSSectionQueue.isEmpty()) {
          const PAT = this.PAT_TSSectionQueue.pop()!;
          if (TSSection.CRC32(PAT) != 0) { continue; }

          let begin = TSSection.EXTENDED_HEADER_SIZE;
          while (begin < TSSection.BASIC_HEADER_SIZE + TSSection.section_length(PAT) - TSSection.CRC_SIZE) {
            const program_number = (PAT[begin + 0] << 8) | PAT[begin + 1];
            const program_map_PID = ((PAT[begin + 2] & 0x1F) << 8) | PAT[begin + 3];
            if (program_map_PID === 0x10) { begin += 4; continue; } // NIT

            if (!this.PMT_TSSectionQueues.has(program_map_PID)) {
              this.PMT_TSSectionQueues.set(program_map_PID, new TSSectionQueue());
              this.PMT_ContinuityCounters.set(program_map_PID, 0);
            }

            begin += 4;
          }
        }

        this.push(packet);
      } else if (this.PMT_TSSectionQueues.has(pid)) {
        const PMT_TSSectionQueue = this.PMT_TSSectionQueues.get(pid)!;

        PMT_TSSectionQueue.push(packet);
        while (!PMT_TSSectionQueue.isEmpty()) {
          const PMT = PMT_TSSectionQueue.pop()!;
          if (TSSection.CRC32(PMT) != 0) { continue; }

          const program_info_length = ((PMT[TSSection.EXTENDED_HEADER_SIZE + 2] & 0x0F) << 8) | PMT[TSSection.EXTENDED_HEADER_SIZE + 3];
          let begin = TSSection.EXTENDED_HEADER_SIZE + 4 + program_info_length;
          while (begin < TSSection.BASIC_HEADER_SIZE + TSSection.section_length(PMT) - TSSection.CRC_SIZE) {
            const stream_type = PMT[begin + 0];
            const elementary_PID = ((PMT[begin + 1] & 0x1F) << 8) | PMT[begin + 2];
            const ES_info_length = ((PMT[begin + 3] & 0x0F) << 8) | PMT[begin + 4];

            if (stream_type !== 0x15) {
              begin += 5 + ES_info_length;
              continue;
            }

            let descriptor = begin + 5;
            while (descriptor < begin + 5 + ES_info_length) {
              const descriptor_tag = PMT[descriptor + 0];
              const descriptor_length = PMT[descriptor + 1];

              if (descriptor_tag === 0x26) {
                /* エンコード用なので結構適当な感じ*/
                if(!this.Metadata_TSPESQueues.has(elementary_PID)) {
                  this.Metadata_TSPESQueues.set(elementary_PID, new TSPESQueue());
                  this.Metadata_ContinuityCounters.set(elementary_PID, 0);
                }
              }

              descriptor += 2 + descriptor_length;
            }

            begin += 5 + ES_info_length;
          }
        }
        this.push(packet);
      } else if (this.Metadata_TSPESQueues.has(pid)) {
        const Metadata_TSPESQueue = this.Metadata_TSPESQueues.get(pid)!;

        Metadata_TSPESQueue.push(packet);
        while (!Metadata_TSPESQueue.isEmpty()) {
          const Metadata_PES = Metadata_TSPESQueue.pop()!;

          let pts = 0;
          pts *= (1 << 3); pts += ((Metadata_PES[TSPES.PES_HEADER_SIZE + 3 + 0] & 0x0E) >> 1);
          pts *= (1 << 8); pts += ((Metadata_PES[TSPES.PES_HEADER_SIZE + 3 + 1] & 0xFF) >> 0);
          pts *= (1 << 7); pts += ((Metadata_PES[TSPES.PES_HEADER_SIZE + 3 + 2] & 0xFE) >> 1);
          pts *= (1 << 8); pts += ((Metadata_PES[TSPES.PES_HEADER_SIZE + 3 + 3] & 0xFF) >> 0);
          pts *= (1 << 7); pts += ((Metadata_PES[TSPES.PES_HEADER_SIZE + 3 + 4] & 0xFE) >> 1);

          const PES_header_data_length = Metadata_PES[TSPES.PES_HEADER_SIZE + 2];
          const PES_payload_begin = (TSPES.PES_HEADER_SIZE + 3) + PES_header_data_length;
          const id3 = Metadata_PES.slice(PES_payload_begin);

          const new_Metadata_PES = ID3.timedmetadata(pts, id3);

          let begin = 0
          while (begin < new_Metadata_PES.length) {
            const header = Buffer.from([
              packet[0],
             ((packet[1] & 0xA0) | ((begin === 0 ? 1 : 0) << 6) | ((pid & 0x1F00) >> 8)),
             (pid & 0x00FF),
             ((packet[3] & 0xC0) | (1 << 4) /* payload */ | (this.Metadata_ContinuityCounters.get(pid)! & 0x0F)),
            ])
            this.Metadata_ContinuityCounters.set(
              pid,
              (this.Metadata_ContinuityCounters.get(pid)! + 1) & 0x0F
            );

            const next = begin + (TSPacket.PACKET_SIZE - TSPacket.HEADER_SIZE)
            this.push(
              Buffer.concat([
                header,
                new_Metadata_PES.slice(begin, next)
              ])
            );

            begin = next
          }
        }
      } else {
        this.push(packet);
      }
    }
    callback();
  }

  _flush (callback: TransformCallback): void {
    callback();
  }
}
