#!/usr/bin/env node

import { Transform, TransformCallback } from 'stream'

import { TSPacket, TSPacketQueue } from 'arib-mpeg2ts-parser';
import { TSSection, TSSectionQueue, TSSectionPacketizer } from 'arib-mpeg2ts-parser';
import { TSPES, TSPESQueue } from 'arib-mpeg2ts-parser';


import ID3 from './id3'

export { default as FFmpegID3PaddingTransform } from './ffmpeg-id3-padding-transform'

export default class MetadataTransform extends Transform {
  private packetQueue = new TSPacketQueue();

  private PAT_TSSectionQueue = new TSSectionQueue();

  private PMT_TSSectionQueues = new Map<number, TSSectionQueue>();
  private PMT_SubtitlePids = new Map<number, number>();
  private PMT_ID3Pids = new Map<number, number>();
  private PMT_ContinuityCounters = new Map<number, number>();

  private Subtitle_TSPESQueues = new Map<number, TSPESQueue>();
  private Subtitle_PMTPids = new Map<number, Set<number>>();

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

          let newPMT = Buffer.from(PMT.slice(0, TSSection.EXTENDED_HEADER_SIZE + 2))

          const program_info_length = ((PMT[TSSection.EXTENDED_HEADER_SIZE + 2] & 0x0F) << 8) | PMT[TSSection.EXTENDED_HEADER_SIZE + 3];
          let newPMT_program_info = Buffer.from([]);
          let begin = TSSection.EXTENDED_HEADER_SIZE + 4;
          while (begin < TSSection.EXTENDED_HEADER_SIZE + 4 + program_info_length) {
            const descriptor_tag = PMT[begin + 0];
            const descriptor_length = PMT[begin + 1];
            newPMT_program_info = Buffer.concat([
              newPMT_program_info,
              PMT.slice(begin, begin + 2 + descriptor_length),
            ]);
            begin += 2 + descriptor_length;
          }
          newPMT_program_info = Buffer.concat([
            newPMT_program_info,
            ID3.metadata_pointer_descriptor(TSSection.table_id_extension(PMT))
          ]);
          const newPMT_program_info_length = Buffer.from([
            ((newPMT_program_info.length & 0xFF00) >> 8), ((newPMT_program_info.length & 0x00FF) >> 0),
          ])

          let newPMT_descriptor_loop = Buffer.from([]);
          let subtitlePid = -1;

          const PMT_PIDs: Set<number> = new Set<number>();
          PMT_PIDs.add(pid);

          begin = TSSection.EXTENDED_HEADER_SIZE + 4 + program_info_length;
          while (begin < TSSection.BASIC_HEADER_SIZE + TSSection.section_length(PMT) - TSSection.CRC_SIZE) {
            const stream_type = PMT[begin + 0];
            const elementary_PID = ((PMT[begin + 1] & 0x1F) << 8) | PMT[begin + 2];
            const ES_info_length = ((PMT[begin + 3] & 0x0F) << 8) | PMT[begin + 4];

            let descriptor = begin + 5;
            while (descriptor < begin + 5 + ES_info_length) {
              const descriptor_tag = PMT[descriptor + 0];
              const descriptor_length = PMT[descriptor + 1];

              if (descriptor_tag == 0x52) {
                const component_tag = PMT[descriptor + 2];

                if (0x30 <= component_tag && component_tag <= 0x37 || component_tag == 0x87) {
                  subtitlePid = elementary_PID;
                }
              }

              descriptor += 2 + descriptor_length;
            }

            PMT_PIDs.add(elementary_PID);
            begin += 5 + ES_info_length;
          }

          let id3_PID: number = 0x1FFE; // TODO: いい感じのPIDを見つけたい。ここがアドホックでトラブルの元。
          {
            const already_ID3Pids = new Set<number>(this.PMT_ID3Pids.values());
            if (this.PMT_ID3Pids.has(pid)) { already_ID3Pids.delete(this.PMT_ID3Pids.get(pid)!); }

            for (; ; id3_PID--) {
              if (PMT_PIDs.has(id3_PID)) { continue; }
              if (already_ID3Pids.has(id3_PID)) { continue; }
              break;
            }
          }
          if (!this.PMT_ID3Pids.has(pid)) { 
            this.PMT_ID3Pids.set(pid, id3_PID);
            this.Metadata_ContinuityCounters.set(id3_PID, 0);
          } else if (this.PMT_ID3Pids.get(pid)! !== id3_PID) {
            this.Metadata_ContinuityCounters.delete(id3_PID);

            this.PMT_ID3Pids.set(pid, id3_PID);
            this.Metadata_ContinuityCounters.set(id3_PID, 0);
          }

          newPMT_descriptor_loop = Buffer.concat([
            PMT.slice(
              TSSection.EXTENDED_HEADER_SIZE + 4 + program_info_length,
              TSSection.BASIC_HEADER_SIZE + TSSection.section_length(PMT) - TSSection.CRC_SIZE
            ),
            ID3.metadata_elementary_stream(id3_PID),
          ])

          if (subtitlePid >= 0) {
            if (!this.PMT_SubtitlePids.has(pid)) {
              this.PMT_SubtitlePids.set(pid, subtitlePid);
              this.Subtitle_TSPESQueues.set(subtitlePid, new TSPESQueue());

              const PMTs = this.Subtitle_PMTPids.get(subtitlePid) ?? new Set();
              PMTs.add(pid);
              this.Subtitle_PMTPids.set(subtitlePid, PMTs);
            } else {
              const oldSubtitlePid = this.PMT_SubtitlePids.get(pid)!;
              if (subtitlePid !== oldSubtitlePid) {
                const oldPMTs = this.Subtitle_PMTPids.get(oldSubtitlePid) ?? new Set<number>();
                oldPMTs.delete(pid);
                this.Subtitle_PMTPids.set(oldSubtitlePid, oldPMTs);

                const newPMTs = this.Subtitle_PMTPids.get(subtitlePid) ?? new Set<number>();
                newPMTs.add(pid);
                this.Subtitle_PMTPids.set(subtitlePid, newPMTs);

                this.PMT_SubtitlePids.set(pid, subtitlePid);
                this.Subtitle_TSPESQueues.set(subtitlePid, new TSPESQueue());

                if (!this.Subtitle_PMTPids.has(oldSubtitlePid) || this.Subtitle_PMTPids.get(oldSubtitlePid)!.size === 0) {
                  this.Subtitle_TSPESQueues.delete(oldSubtitlePid);
                }
              }
            }
          } else if (this.PMT_SubtitlePids.has(pid)) {
            const oldSubtitlePid = this.PMT_SubtitlePids.get(pid)!;
            this.PMT_SubtitlePids.delete(pid);

            const oldPMTs = this.Subtitle_PMTPids.get(oldSubtitlePid) ?? new Set<number>();
            oldPMTs.delete(pid);
            this.Subtitle_PMTPids.set(oldSubtitlePid, oldPMTs);

            if (!this.Subtitle_PMTPids.has(oldSubtitlePid) || this.Subtitle_PMTPids.get(oldSubtitlePid)!.size === 0) {
              this.Subtitle_TSPESQueues.delete(oldSubtitlePid);
            }
          }

          newPMT = Buffer.concat([
            newPMT,
            newPMT_program_info_length,
            newPMT_program_info,
            newPMT_descriptor_loop,
          ]);

          const newPMT_length = newPMT.length + TSSection.CRC_SIZE - TSSection.BASIC_HEADER_SIZE;
          newPMT[1] = (PMT[1] & 0xF0) | ((newPMT_length & 0x0F00) >> 8);
          newPMT[2] = (newPMT_length & 0x00FF);

          const newPMT_CRC = TSSection.CRC32(newPMT);
          newPMT = Buffer.concat([newPMT, Buffer.from([
            (newPMT_CRC & 0xFF000000) >> 24,
            (newPMT_CRC & 0x00FF0000) >> 16,
            (newPMT_CRC & 0x0000FF00) >> 8,
            (newPMT_CRC & 0x000000FF) >> 0,
          ])]);

          const packets = TSSectionPacketizer.packetize(
            newPMT,
            TSPacket.transport_error_indicator(packet),
            TSPacket.transport_priority(packet),
            pid,
            TSPacket.transport_scrambling_control(packet),
            this.PMT_ContinuityCounters.get(pid)!
          );
          for (let i = 0; i < packets.length; i++) { this.push(packets[i]); }
          this.PMT_ContinuityCounters.set(pid, (this.PMT_ContinuityCounters.get(pid)! + packets.length) & 0x0F);
        }
      } else if (this.Subtitle_TSPESQueues.has(pid)) {
        const Subtitle_TSPESQueue = this.Subtitle_TSPESQueues.get(pid)!;

        Subtitle_TSPESQueue.push(packet);
        while (!Subtitle_TSPESQueue.isEmpty()) {
          const SubtitlePES = Subtitle_TSPESQueue.pop()!;

          let pts = 0;
          pts *= (1 << 3); pts += ((SubtitlePES[TSPES.PES_HEADER_SIZE + 3 + 0] & 0x0E) >> 1);
          pts *= (1 << 8); pts += ((SubtitlePES[TSPES.PES_HEADER_SIZE + 3 + 1] & 0xFF) >> 0);
          pts *= (1 << 7); pts += ((SubtitlePES[TSPES.PES_HEADER_SIZE + 3 + 2] & 0xFE) >> 1);
          pts *= (1 << 8); pts += ((SubtitlePES[TSPES.PES_HEADER_SIZE + 3 + 3] & 0xFF) >> 0);
          pts *= (1 << 7); pts += ((SubtitlePES[TSPES.PES_HEADER_SIZE + 3 + 4] & 0xFE) >> 1);

          const PES_header_data_length = SubtitlePES[TSPES.PES_HEADER_SIZE + 2];
          const PES_data_packet_header_length = (SubtitlePES[(TSPES.PES_HEADER_SIZE + 3) + PES_header_data_length + 2] & 0x0F);
          const data_group = TSPES.PES_HEADER_SIZE + (3 + PES_header_data_length) + (3 + PES_data_packet_header_length);
          const data_group_id = (SubtitlePES[data_group + 0] & 0xFC) >> 2;

          if ((data_group_id & 0x0F) != 1) { // FIXME!
            continue; // FIXME!
          } // FIXME!

          for (const PMT_PID of Array.from(this.Subtitle_PMTPids.get(pid) ?? [])) {
            if (!this.PMT_ID3Pids.has(PMT_PID)) { continue; }

            const timedMetadataPID = this.PMT_ID3Pids.get(PMT_PID)!;
            const subtitleData = SubtitlePES.slice(TSPES.PES_HEADER_SIZE + (3 + PES_header_data_length));
            const id3 = ID3.ID3v2PRIV('aribb24.js', subtitleData);
            const timedMetadataPES = ID3.timedmetadata(pts, id3);

            let begin = 0
            while (begin < timedMetadataPES.length) {
              const header = Buffer.from([
                packet[0],
               ((packet[1] & 0xA0) | ((begin === 0 ? 1 : 0) << 6) | ((timedMetadataPID & 0x1F00) >> 8)),
               (timedMetadataPID & 0x00FF),
               ((packet[3] & 0xC0) | (1 << 4) /* payload */ | (this.Metadata_ContinuityCounters.get(timedMetadataPID)! & 0x0F)),
              ])
              this.Metadata_ContinuityCounters.set(
                timedMetadataPID,
                (this.Metadata_ContinuityCounters.get(timedMetadataPID)! + 1) & 0x0F
              );

              const next = begin + (TSPacket.PACKET_SIZE - TSPacket.HEADER_SIZE)
              this.push(
                Buffer.concat([
                  header,
                  timedMetadataPES.slice(begin, next)
                ])
              );

              begin = next
            }
          }
        }

        this.push(packet);
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
