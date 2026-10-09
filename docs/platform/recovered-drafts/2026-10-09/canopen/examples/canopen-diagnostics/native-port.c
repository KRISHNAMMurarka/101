/* Owned selected CANopen diagnostic port. No third-party stack is linked.
 * Default executable admits only the scripted software role; native admission
 * requires a separately reviewed candidate and real OS-clock/environment proof. */
#define _POSIX_C_SOURCE 200809L
#ifdef __linux__
#define _DEFAULT_SOURCE
#endif
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <errno.h>
#include <signal.h>
#include <fcntl.h>
#include <time.h>
#include <unistd.h>
#include <sys/select.h>
#ifdef __linux__
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <net/if.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#include <linux/can/error.h>
#endif

enum { RECORD=128, QUEUE=65536, MAX_FRAMES=256, MAX_RECORDS=512 };
typedef struct {
  uint8_t nonce[16], node, role, interface_len; char interface_name[16];
  uint32_t generation, in_sequence, out_sequence, rx_sequence, frames, bytes, expected_index;
  uint64_t expiry, namespace_inode; uint32_t last_read; int configured, done, fault;
  uint8_t in[QUEUE], out[QUEUE]; size_t in_len, out_len;
} Port;
static volatile sig_atomic_t interrupted;
static void stop_signal(int value) { (void)value; interrupted=1; }
static uint32_t u32(const uint8_t *p) { return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24); }
static uint64_t u64(const uint8_t *p) { return (uint64_t)u32(p)|((uint64_t)u32(p+4)<<32); }
static void put32(uint8_t *p,uint32_t value) { for(unsigned at=0;at<4;at++)p[at]=(uint8_t)(value>>(8*at)); }
#ifdef __linux__
static void put64(uint8_t *p,uint64_t value) { for(unsigned at=0;at<8;at++)p[at]=(uint8_t)(value>>(8*at)); }
#endif
static uint64_t monotonic_ns(void) {
  struct timespec stamp; if(clock_gettime(CLOCK_MONOTONIC,&stamp)!=0)exit(70);
  return (uint64_t)stamp.tv_sec*UINT64_C(1000000000)+(uint64_t)stamp.tv_nsec;
}
static int zero(const uint8_t *p,size_t size) { for(size_t at=0;at<size;at++)if(p[at])return 0;return 1; }
static int emit(Port *port,uint8_t kind,const uint8_t *payload) {
  if(port->out_len+RECORD>QUEUE || port->out_sequence>=MAX_RECORDS) { port->done=1;port->fault=12;return 0; }
  uint8_t *record=port->out+port->out_len; memset(record,0,RECORD);memcpy(record,"C101",4);record[4]=1;record[5]=kind;
  memcpy(record+8,port->nonce,16);put32(record+24,port->generation);put32(record+28,++port->out_sequence);
  if(payload)memcpy(record+32,payload,96);
  port->out_len+=RECORD;return 1;
}
static void fail(Port *port,int code) {
  if(port->done)return;
  port->done=1;port->fault=code;
  if(port->configured) { uint8_t payload[96]={0};put32(payload,(uint32_t)code);(void)emit(port,7,payload); }
}
static int nonblock(int fd) { int flags=fcntl(fd,F_GETFL,0);return flags>=0&&fcntl(fd,F_SETFL,flags|O_NONBLOCK)==0; }
static int header(Port *port,const uint8_t *record,int first) {
  if(memcmp(record,"C101",4)!=0||record[4]!=1||!zero(record+6,2)||u32(record+24)==0||u32(record+28)!=port->in_sequence+1||port->in_sequence>=MAX_RECORDS)return 0;
  if(!first&&(memcmp(record+8,port->nonce,16)!=0||u32(record+24)!=port->generation))return 0;
  port->in_sequence++;return 1;
}
static int configure(Port *port,const uint8_t *record,uint8_t expected_role) {
  if(!header(port,record,1)||record[5]!=1)return 0;
  const uint8_t *p=record+32;uint64_t lifetime=u64(p+20);
  if(p[0]<1||p[0]>127||p[1]!=expected_role||p[2]<1||p[2]>15||p[3]!=0||!zero(p+4+p[2],16-p[2])||
    u32(p+28)!=256||u32(p+32)!=4096||u32(p+36)!=1000||u64(p+40)!=UINT64_C(1000000000)||!zero(p+60,36))return 0;
  for(unsigned at=0;at<p[2];at++) { unsigned char c=p[4+at];if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='-'))return 0; }
  if(expected_role==2&&(p[2]!=7||memcmp(p+4,"harness",7)!=0||u64(p+48)!=0||u32(p+56)!=0||lifetime==0||lifetime>UINT64_C(30000000000)))return 0;
  memcpy(port->nonce,record+8,16);port->generation=u32(record+24);port->node=p[0];port->role=p[1];port->interface_len=p[2];
  memcpy(port->interface_name,p+4,p[2]);port->namespace_inode=u64(p+48);port->expected_index=u32(p+56);
  port->expiry=expected_role==2?monotonic_ns()+lifetime:lifetime;port->configured=1;return 1;
}
static int read_target(Port *port,const uint8_t *record,uint16_t *index,uint8_t *width,uint64_t *deadline) {
  const uint8_t *p=record+32;uint32_t ordinal=u32(p);uint16_t object=(uint16_t)(p[4]|(uint16_t)p[5]<<8);
  if(record[5]!=2||ordinal!=port->last_read+1||ordinal>2||p[6]!=0||!zero(p+16,80))return 0;
  if((ordinal==1&&(object!=0x1000||p[7]!=4))||(ordinal==2&&(object!=0x1001||p[7]!=1)))return 0;
  uint64_t budget=u64(p+8);if(budget==0)return 0;
  if(port->role==2) { if(budget>UINT64_C(1000000000))return 0;*deadline=monotonic_ns()+budget; }
  else *deadline=budget;
  if(*deadline>port->expiry)*deadline=port->expiry;
  if(monotonic_ns()>=*deadline)return 0;
  port->last_read=ordinal;*index=object;*width=p[7];return 1;
}
static int frame(Port *port,const uint8_t raw[16],uint32_t request,const uint8_t *native_metadata) {
  port->frames++;port->bytes+=16;if(port->frames>MAX_FRAMES||port->bytes>4096) { fail(port,8);return 0; }
  uint8_t payload[96]={0};put32(payload,++port->rx_sequence);put32(payload+28,16);memcpy(payload+40,raw,16);put32(payload+56,request);
  if(native_metadata) { memcpy(payload+4,native_metadata,24);memcpy(payload+32,native_metadata+24,8); }
  return emit(port,5,payload);
}
static void heartbeat(Port *port,uint8_t state) { uint8_t raw[16]={0};put32(raw,0x700+port->node);raw[4]=1;raw[8]=state;(void)frame(port,raw,0,NULL); }
static void scripted_read(Port *port,const uint8_t *record) {
  uint16_t index=0;uint8_t width=0;uint64_t deadline=0;
  if(!read_target(port,record,&index,&width,&deadline)) { fail(port,11);return; }
  if(monotonic_ns()>=deadline) { fail(port,9);return; }
  uint8_t dispatched[96]={0};put32(dispatched,port->last_read);put32(dispatched+4,16);(void)emit(port,6,dispatched);
  uint8_t raw[16]={0};put32(raw,0x580+port->node);raw[4]=8;raw[8]=width==4?0x43:0x4f;raw[9]=(uint8_t)index;raw[10]=(uint8_t)(index>>8);
#ifdef CAN_HARNESS_ABORT_FIRST
  if(index==0x1000) { raw[8]=0x80;put32(raw+12,UINT32_C(0x06020000)); }
  else raw[12]=255;
#else
  if(width==4)put32(raw+12,UINT32_MAX);else raw[12]=255;
#endif
  (void)frame(port,raw,port->last_read,NULL);
}
static void consume_scripted(Port *port,const uint8_t *record) {
  if(!port->configured) { if(!configure(port,record,2)) { fail(port,7);return; }(void)emit(port,4,NULL);return; }
  if(!header(port,record,0)) { fail(port,7);return; }
  if(record[5]==3&&zero(record+32,96)) { port->done=1;return; }
  scripted_read(port,record);
}
static void flush(Port *port) {
  if(!port->out_len)return;
  ssize_t count=write(STDOUT_FILENO,port->out,port->out_len);
  if(count>0) { port->out_len-=(size_t)count;memmove(port->out,port->out+count,port->out_len); }
  else if(count<0&&errno!=EAGAIN&&errno!=EWOULDBLOCK&&errno!=EINTR) { port->done=1;port->fault=12;port->out_len=0; }
}
static int scripted(void) {
  Port port={0};if(!nonblock(STDIN_FILENO)||!nonblock(STDOUT_FILENO))return 70;
  uint64_t next_heartbeat=0,shutdown_deadline=0;unsigned states=0;const uint8_t schedule[]={0,4,127,5};
  while(!interrupted) {
    uint64_t at=monotonic_ns();
    if(port.configured&&!port.done&&at>=port.expiry)fail(&port,9);
    if(port.done&&shutdown_deadline==0)shutdown_deadline=at+UINT64_C(100000000);
    if(port.done&&(port.out_len==0||at>=shutdown_deadline))break;
    fd_set read_set,write_set;FD_ZERO(&read_set);FD_ZERO(&write_set);if(!port.done)FD_SET(STDIN_FILENO,&read_set);if(port.out_len)FD_SET(STDOUT_FILENO,&write_set);
    struct timeval wait={0,10000};int result=select(STDOUT_FILENO+1,&read_set,&write_set,NULL,&wait);
    if(result<0&&errno!=EINTR) { fail(&port,7);continue; }
    if(FD_ISSET(STDIN_FILENO,&read_set)) {
      ssize_t count=read(STDIN_FILENO,port.in+port.in_len,QUEUE-port.in_len);
      if(count==0) { if(port.in_len)fail(&port,7);else port.done=1; }
      else if(count>0) {
        port.in_len+=(size_t)count;
        while(port.in_len>=RECORD&&!port.done) { uint8_t record[RECORD];memcpy(record,port.in,RECORD);port.in_len-=RECORD;memmove(port.in,port.in+RECORD,port.in_len);consume_scripted(&port,record); }
        if(port.in_len==QUEUE)fail(&port,8);
      } else if(errno!=EAGAIN&&errno!=EWOULDBLOCK&&errno!=EINTR)fail(&port,7);
    }
    if(port.configured&&!port.done) {
      at=monotonic_ns();if(next_heartbeat==0)next_heartbeat=at+UINT64_C(50000000);
      if(at>=next_heartbeat) { heartbeat(&port,states<4?schedule[states++]:5);next_heartbeat=at+UINT64_C(50000000); }
    }
    if(FD_ISSET(STDOUT_FILENO,&write_set))flush(&port);
  }
  return interrupted?143:port.fault?65:0;
}

#ifdef __linux__
/* Compiled for source review/build qualification; default main cannot call this.
 * Native environment/clock authorization remains a separate blocked admission. */
static int native_receiver(Port *port) {
  int fd=-1,result=65;struct stat ns;struct ifreq ifr;memset(&ifr,0,sizeof(ifr));
  if(monotonic_ns()>=port->expiry||stat("/proc/self/ns/net",&ns)!=0||(uint64_t)ns.st_ino!=port->namespace_inode)return 65;
  fd=socket(PF_CAN,SOCK_RAW|SOCK_NONBLOCK|SOCK_CLOEXEC,CAN_RAW);if(fd<0)return 65;
  memcpy(ifr.ifr_name,port->interface_name,port->interface_len);
  if(ioctl(fd,SIOCGIFINDEX,&ifr)!=0||(uint32_t)ifr.ifr_ifindex!=port->expected_index)goto out;
  if(ioctl(fd,SIOCGIFMTU,&ifr)!=0||ifr.ifr_mtu!=CAN_MTU)goto out;
  struct can_filter filters[2]={{0x700+port->node,CAN_EFF_FLAG|CAN_RTR_FLAG|CAN_SFF_MASK},{0x580+port->node,CAN_EFF_FLAG|CAN_RTR_FLAG|CAN_SFF_MASK}};
  int yes=1,no=0;can_err_mask_t errors=CAN_ERR_MASK;
  if(setsockopt(fd,SOL_CAN_RAW,CAN_RAW_FILTER,filters,sizeof(filters))!=0||setsockopt(fd,SOL_CAN_RAW,CAN_RAW_ERR_FILTER,&errors,sizeof(errors))!=0||
    setsockopt(fd,SOL_CAN_RAW,CAN_RAW_RECV_OWN_MSGS,&no,sizeof(no))!=0||setsockopt(fd,SOL_SOCKET,64,&yes,sizeof(yes))!=0||setsockopt(fd,SOL_SOCKET,40,&yes,sizeof(yes))!=0)goto out;
  struct sockaddr_can address;memset(&address,0,sizeof(address));address.can_family=AF_CAN;address.can_ifindex=(int)port->expected_index;
  if(monotonic_ns()>=port->expiry||bind(fd,(struct sockaddr *)&address,sizeof(address))!=0)goto out;
  uint8_t ready[96]={0};put32(ready,port->expected_index);put32(ready+4,CAN_MTU);put64(ready+8,monotonic_ns());(void)emit(port,4,ready);
  uint32_t previous_overflow=0;int had_overflow=0;uint64_t read_deadline=0;
  while(!interrupted&&!port->done) {
    if(monotonic_ns()>=port->expiry||(read_deadline&&monotonic_ns()>=read_deadline)) { fail(port,9);break; }
    fd_set reads,writes;FD_ZERO(&reads);FD_ZERO(&writes);FD_SET(fd,&reads);FD_SET(STDIN_FILENO,&reads);if(port->out_len)FD_SET(STDOUT_FILENO,&writes);
    struct timeval wait={0,10000};int selected=select(fd+1,&reads,&writes,NULL,&wait);
    if(selected<0) { if(errno==EINTR)continue;fail(port,2);break; }
    if(FD_ISSET(STDIN_FILENO,&reads)) {
      ssize_t count=read(STDIN_FILENO,port->in+port->in_len,QUEUE-port->in_len);
      if(count<=0) { if(count==0)port->done=1;else if(errno!=EAGAIN&&errno!=EINTR)fail(port,7); }
      else { port->in_len+=(size_t)count;
        while(port->in_len>=RECORD&&!port->done) {
          uint8_t record[RECORD];memcpy(record,port->in,RECORD);port->in_len-=RECORD;memmove(port->in,port->in+RECORD,port->in_len);
          if(!header(port,record,0)) { fail(port,7);break; }
          if(record[5]==3&&zero(record+32,96)) { port->done=1;break; }
          uint16_t index;uint8_t width;
          if(read_deadline||!read_target(port,record,&index,&width,&read_deadline)) { fail(port,11);break; }
          struct can_frame request;memset(&request,0,sizeof(request));request.can_id=0x600+port->node;request.len=8;request.data[0]=0x40;request.data[1]=(uint8_t)index;request.data[2]=(uint8_t)(index>>8);
          if(monotonic_ns()>=read_deadline||write(fd,&request,sizeof(request))!=sizeof(request)) { fail(port,2);break; }
          uint8_t dispatched[96]={0};put32(dispatched,port->last_read);put32(dispatched+4,16);(void)emit(port,6,dispatched);
        }
      }
    }
    if(FD_ISSET(fd,&reads)&&!port->done) {
      struct can_frame received;char control[CMSG_SPACE(16)+CMSG_SPACE(4)];struct iovec vector={&received,sizeof(received)};struct msghdr message;memset(&message,0,sizeof(message));
      message.msg_iov=&vector;message.msg_iovlen=1;message.msg_control=control;message.msg_controllen=sizeof(control);
      ssize_t count=recvmsg(fd,&message,MSG_DONTWAIT);uint64_t receipt=monotonic_ns();
      if(count<0&&(errno==EAGAIN||errno==EINTR))continue;
      if(count!=CAN_MTU||(message.msg_flags&(MSG_TRUNC|MSG_CTRUNC))) { port->frames++;port->bytes+=count>0?(uint32_t)count:0;fail(port,4);break; }
      uint8_t metadata[32]={0};put32(metadata,(uint32_t)message.msg_flags);put64(metadata+24,receipt);uint32_t presence=0,overflow=0;
      for(struct cmsghdr *c=CMSG_FIRSTHDR(&message);c;c=CMSG_NXTHDR(&message,c)) {
        if(c->cmsg_level!=SOL_SOCKET)continue;
        if(c->cmsg_type==64&&c->cmsg_len==CMSG_LEN(16)) { int64_t stamp[2];memcpy(stamp,CMSG_DATA(c),16);if(stamp[1]<0||stamp[1]>=1000000000) { fail(port,4);break; }
          put64(metadata+12,(uint64_t)stamp[0]);put32(metadata+20,(uint32_t)stamp[1]);presence|=1; }
        else if(c->cmsg_type==40&&c->cmsg_len==CMSG_LEN(4)) { memcpy(&overflow,CMSG_DATA(c),4);put32(metadata+4,overflow);presence|=2; }
      }
      put32(metadata+8,presence);uint32_t ordinal=received.can_id==UINT32_C(0x580)+(uint32_t)port->node?port->last_read:0;(void)frame(port,(const uint8_t *)&received,ordinal,metadata);
      if(received.can_id&CAN_ERR_FLAG) { fail(port,5);break; }
      if((presence&2)&&((had_overflow&&(uint32_t)(overflow-previous_overflow)!=0)||(!had_overflow&&overflow!=0))) { fail(port,6);break; }
      if(presence&2) { previous_overflow=overflow;had_overflow=1; }
      if(!(presence&1)) { fail(port,4);break; }
      if(ordinal)read_deadline=0;
    }
    if(FD_ISSET(STDOUT_FILENO,&writes))flush(port);
  }
  result=port->fault?65:0;
out:
  if(fd>=0)(void)close(fd);
  return result;
}
#endif
int main(int argc,char **argv) {
  struct sigaction action;memset(&action,0,sizeof(action));action.sa_handler=stop_signal;sigemptyset(&action.sa_mask);
  (void)sigaction(SIGTERM,&action,NULL);(void)sigaction(SIGINT,&action,NULL);signal(SIGPIPE,SIG_IGN);
#ifdef __linux__
  (void)native_receiver; /* Build checks native APIs without granting entry. */
#endif
  if(argc!=2||strcmp(argv[1],"--scripted-harness")!=0) { fputs("blocked-native-environment\n",stderr);return 78; }
  return scripted();
}
